use futures::StreamExt;
use rig::http_client::{
    BoxedStream, Bytes, Error, HttpClientExt, LazyBody, MultipartForm, Request, ReqwestClient,
    Response, Result, StreamingResponse,
};
use rig::wasm_compat::WasmCompatSend;
use std::{error::Error as StdError, fmt, future::Future};

#[derive(Default)]
pub(super) struct DetailedHttpClient(ReqwestClient);

// Rig's streaming error reports omit the transport's source chain. Preserve it
// in Display before the error is converted to a report and loses its sources.
#[derive(Debug)]
struct DetailedError(Box<dyn StdError + Send + Sync>);

impl fmt::Display for DetailedError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.0)?;
        let mut source = self.0.source();
        while let Some(cause) = source {
            write!(formatter, "\n{cause}")?;
            source = cause.source();
        }
        Ok(())
    }
}

impl StdError for DetailedError {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(self.0.as_ref())
    }
}

fn with_details(error: Error) -> Error {
    match error {
        Error::Instance(cause) => Error::Instance(Box::new(DetailedError(cause))),
        Error::Unbuilt(cause) => Error::Unbuilt(Box::new(DetailedError(cause))),
        other => other,
    }
}

async fn detailed_response<U: WasmCompatSend + 'static>(
    pending: impl Future<Output = Result<Response<LazyBody<U>>>>,
) -> Result<Response<LazyBody<U>>> {
    let response = pending.await.map_err(with_details)?;
    Ok(response.map(|body| {
        Box::pin(async move { body.await.map_err(with_details) }) as LazyBody<U>
    }))
}

impl HttpClientExt for DetailedHttpClient {
    fn send<T, U>(
        &self,
        request: Request<T>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        T: Into<Bytes> + WasmCompatSend,
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        detailed_response(self.0.send(request))
    }

    fn send_multipart<U>(
        &self,
        request: Request<MultipartForm>,
    ) -> impl Future<Output = Result<Response<LazyBody<U>>>> + WasmCompatSend + 'static
    where
        U: From<Bytes> + WasmCompatSend + 'static,
    {
        detailed_response(self.0.send_multipart(request))
    }

    fn send_streaming<T>(
        &self,
        request: Request<T>,
    ) -> impl Future<Output = Result<StreamingResponse>> + WasmCompatSend
    where
        T: Into<Bytes> + WasmCompatSend,
    {
        let pending = self.0.send_streaming(request);
        async move {
            let response = pending.await.map_err(with_details)?;
            Ok(response.map(|body| {
                Box::pin(body.map(|chunk| chunk.map_err(with_details))) as BoxedStream
            }))
        }
    }
}
