use super::*;
use rig::{
    completion::GetTokenUsage,
    message::AssistantContent,
    tool::{DynamicTool, ToolOutput},
    OneOrMany,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

fn input(role: &str, content: &str, model_messages: Option<Value>) -> AiInputMessage {
    AiInputMessage {
        role: role.to_string(),
        content: content.to_string(),
        attachments: Vec::new(),
        model_messages,
    }
}

#[test]
fn restores_tool_calls_results_and_reasoning_without_rewriting_the_prefix() {
    let transcript = vec![
        Message::Assistant {
            id: Some("provider-id".into()),
            content: OneOrMany::many(vec![
                AssistantContent::reasoning("check uptime"),
                AssistantContent::tool_call("call-1", "read_file", json!({"path": "/proc/uptime"})),
            ])
            .unwrap(),
        },
        Message::tool_result("call-1", "123.45"),
        Message::assistant("running"),
    ];
    let (prompt, history) = split_messages(vec![
        input("user", "inspect", None),
        input(
            "assistant",
            "running",
            Some(serde_json::to_value(&transcript).unwrap()),
        ),
        input("user", "continue", None),
    ])
    .unwrap();
    assert_eq!(prompt, Message::user("continue"));
    let mut expected = vec![Message::user("inspect")];
    expected.extend(transcript);
    // Rig deserializes absent flattened text metadata as an empty map; its
    // serialized representation (and therefore the provider prefix) is stable.
    assert_eq!(
        serde_json::to_value(history).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
}

#[test]
fn old_or_invalid_transcripts_fall_back_to_visible_text() {
    for transcript in [
        None,
        Some(json!([])),
        Some(json!({"invalid": true})),
        Some(
            serde_json::to_value(vec![Message::system("stale"), Message::assistant("reply")])
                .unwrap(),
        ),
        Some(
            serde_json::to_value(vec![
                Message::assistant("call"),
                Message::tool_result("id", "result"),
            ])
            .unwrap(),
        ),
    ] {
        let (_, history) = split_messages(vec![
            input("user", "inspect", None),
            input("assistant", "reply", transcript),
            input("user", "continue", None),
        ])
        .unwrap();
        assert_eq!(
            history,
            vec![Message::user("inspect"), Message::assistant("reply")]
        );
    }
}

#[test]
fn aggregate_cache_usage_and_latest_context_are_independent() {
    let mut usage = Usage::new();
    usage.input_tokens = 4000;
    usage.output_tokens = 200;
    usage.total_tokens = 4200;
    usage.cached_input_tokens = 3600;
    let snapshot = AiTokenUsage::from_rig(usage, 2, 2500);
    assert_eq!(snapshot.input_tokens, 4000);
    assert_eq!(snapshot.cached_tokens, 3600);
    assert_eq!(snapshot.context_tokens, 2500);
    assert_eq!(snapshot.requests, 2);
    assert!(!AiTokenUsage::from_rig(Usage::new(), 1, 0).available);
}

#[test]
fn responses_cache_details_are_preserved() {
    let usage: openai::responses_api::ResponsesUsage = serde_json::from_value(json!({
        "input_tokens": 2000, "output_tokens": 100, "total_tokens": 2100,
        "input_tokens_details": {"cached_tokens": 1800},
        "output_tokens_details": {"reasoning_tokens": 40}
    }))
    .unwrap();
    let snapshot = AiTokenUsage::from_rig(usage.token_usage(), 1, 2000);
    assert_eq!(snapshot.cached_tokens, 1800);
    assert_eq!(snapshot.reasoning_tokens, 40);
    assert_eq!(snapshot.total_tokens, 2100);
}

// Exercise Rig's actual streaming transport, tool loop, and serialized requests.
// No API credentials or SSH server are needed.
fn mock_provider(
    mode: AiApiMode,
    standard_cache_details: bool,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(15);
        for turn in 0..3 {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    other => panic!("mock provider did not receive request: {other:?}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buffer = [0; 4096];
            let header_end = loop {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let path = match mode {
                AiApiMode::ChatCompletions => "/v1/chat/completions",
                AiApiMode::Responses => "/v1/responses",
            };
            assert!(headers.starts_with(&format!("POST {path} HTTP/1.1")));
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            while bytes.len() < header_end + length {
                let count = socket.read(&mut buffer).unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&buffer[..count]);
            }
            requests.push(
                serde_json::from_slice::<Value>(&bytes[header_end..header_end + length]).unwrap(),
            );
            let (input_tokens, cached_tokens, reasoning_tokens) = match turn {
                0 => (2000, 1800, 40),
                1 => (2500, 2300, 20),
                _ => (3000, 2500, 10),
            };
            let body = match mode {
                AiApiMode::ChatCompletions => {
                    let mut usage = json!({
                        "prompt_tokens": input_tokens, "completion_tokens": 100,
                        "total_tokens": input_tokens + 100,
                        "completion_tokens_details": {"reasoning_tokens": reasoning_tokens}
                    });
                    if standard_cache_details {
                        usage["prompt_tokens_details"] = json!({"cached_tokens": cached_tokens});
                    } else {
                        usage["prompt_cache_hit_tokens"] = json!(cached_tokens);
                    }
                    chat_stream_body(turn, usage)
                }
                AiApiMode::Responses => responses_stream_body(
                    turn,
                    json!({
                        "input_tokens": input_tokens, "output_tokens": 100,
                        "total_tokens": input_tokens + 100,
                        "input_tokens_details": {"cached_tokens": cached_tokens},
                        "output_tokens_details": {"reasoning_tokens": reasoning_tokens}
                    }),
                ),
            };
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
        requests
    });
    (format!("{endpoint}/v1"), server)
}

fn chat_stream_body(turn: usize, usage: Value) -> String {
    let delta = if turn == 0 {
        json!({"tool_calls": [{"index": 0, "id": "call-1", "type": "function", "function": {"name": "inspect", "arguments": "{}"}}]})
    } else {
        json!({"content": "running"})
    };
    format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"id": "chat-1", "choices": [{"index": 0, "delta": delta, "finish_reason": null}]}),
        json!({"id": "chat-1", "choices": [{"index": 0, "delta": {}, "finish_reason": if turn == 0 { "tool_calls" } else { "stop" }}]}),
        json!({"choices": [], "usage": usage}),
    )
}

fn responses_stream_body(turn: usize, usage: Value) -> String {
    let reasoning = json!({
        "type": "reasoning", "id": format!("rs_{turn}"), "status": "completed",
        "summary": [{"type": "summary_text", "text": "check server"}],
        "encrypted_content": format!("encrypted-{turn}")
    });
    let output = if turn == 0 {
        json!({
            "type": "function_call", "id": "fc_1", "call_id": "call-1",
            "name": "inspect", "arguments": "{}", "status": "completed"
        })
    } else {
        json!({
            "type": "message", "id": format!("msg_{turn}"), "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": "running", "annotations": []}]
        })
    };
    let mut events = vec![json!({
        "type": "response.output_item.done", "sequence_number": 1, "output_index": 0,
        "item": reasoning
    })];
    if turn != 0 {
        events.push(json!({
            "type": "response.output_text.delta", "sequence_number": 2, "output_index": 1,
            "item_id": format!("msg_{turn}"), "content_index": 0, "delta": "running"
        }));
    }
    events.push(json!({
        "type": "response.output_item.done", "sequence_number": 3, "output_index": 1,
        "item": output
    }));
    events.push(json!({
        "type": "response.completed", "sequence_number": 4,
        "response": {
            "id": format!("resp_{turn}"), "object": "response", "created_at": 1,
            "status": "completed", "model": "test-model", "usage": usage,
            "output": [reasoning, output]
        }
    }));
    events
        .into_iter()
        .map(|event| {
            format!(
                "event: {}\ndata: {event}\n\n",
                event["type"].as_str().unwrap()
            )
        })
        .collect()
}

async fn verify_cache_roundtrip<M>(
    model: M,
    server: std::thread::JoinHandle<Vec<Value>>,
    mode: AiApiMode,
) where
    M: CompletionModel + Clone + 'static,
    M::StreamingResponse: Send + Unpin,
{
    let make_agent = || {
        AgentBuilder::new(model.clone())
            .preamble("stable instructions")
            .dynamic_tools(vec![DynamicTool::new(
                "inspect",
                "inspect",
                json!({"type": "object", "properties": {}}),
                |_, _| Box::pin(async { Ok(ToolOutput::text("123.45")) }),
            )])
            .build()
    };
    let agent = make_agent();
    let empty_history: &[Message] = &[];
    let mut stream = agent
        .stream_chat("inspect", empty_history)
        .max_turns(2)
        .await;
    let mut response = None;
    let mut calls = Vec::new();
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        match item.unwrap() {
            MultiTurnStreamItem::FinalResponse(result) => response = Some(result),
            MultiTurnStreamItem::CompletionCall(call) => calls.push(call.usage),
            _ => {}
        }
    }
    let response = response.unwrap();
    assert_eq!(response.output, "running");
    assert_eq!(calls.len(), 2);
    assert_eq!(response.usage.input_tokens, 4500);
    assert_eq!(response.usage.output_tokens, 200);
    assert_eq!(response.usage.total_tokens, 4700);
    assert_eq!(response.usage.cached_input_tokens, 4100);
    assert_eq!(response.usage.reasoning_tokens, 60);
    let snapshot = AiTokenUsage::from_rig(
        response.usage,
        calls.len() as u32,
        calls.last().unwrap().input_tokens,
    );
    assert_eq!(snapshot.context_tokens, 2500);
    let transcript: Vec<_> = response.messages.unwrap().into_iter().skip(1).collect();
    let (prompt, history) = split_messages(vec![
        input("user", "inspect", None),
        input(
            "assistant",
            &response.output,
            Some(serde_json::to_value(transcript).unwrap()),
        ),
        input("user", "continue", None),
    ])
    .unwrap();
    let agent = make_agent();
    let mut stream = agent.stream_chat(prompt, &history).await;
    let mut second_response = None;
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        if let MultiTurnStreamItem::FinalResponse(response) = item.unwrap() {
            second_response = Some(response);
        }
    }
    let second_response = second_response.unwrap();
    assert_eq!(second_response.usage.cached_input_tokens, 2500);
    assert_eq!(second_response.usage.reasoning_tokens, 10);
    let requests = server.join().unwrap();
    let field = match mode {
        AiApiMode::ChatCompletions => "messages",
        AiApiMode::Responses => "input",
    };
    let tool_followup = requests[1][field].as_array().unwrap();
    let next_turn = requests[2][field].as_array().unwrap();
    assert_eq!(&next_turn[..tool_followup.len()], tool_followup);
    assert_eq!(requests[0]["tools"], requests[2]["tools"]);
    assert_eq!(next_turn.last().unwrap()["role"], "user");
    assert!(next_turn.last().unwrap()["content"]
        .to_string()
        .contains("continue"));
    for request in &requests {
        assert_eq!(request["stream"], true);
        assert_eq!(request["model"], "test-model");
        let tool = &request["tools"][0];
        assert_eq!(tool["type"], "function");
        match mode {
            AiApiMode::ChatCompletions => {
                assert_eq!(tool["function"]["name"], "inspect");
                assert_eq!(request["stream_options"]["include_usage"], true);
                assert!(request.get("input").is_none());
            }
            AiApiMode::Responses => {
                assert_eq!(tool["name"], "inspect");
                assert!(tool.get("function").is_none());
                assert!(request.get("messages").is_none());
                assert!(request.get("stream_options").is_none());
            }
        }
    }
    match mode {
        AiApiMode::ChatCompletions => {
            assert!(tool_followup
                .iter()
                .any(|item| item["tool_calls"][0]["id"] == "call-1"));
            assert!(tool_followup
                .iter()
                .any(|item| item["role"] == "tool" && item["tool_call_id"] == "call-1"));
        }
        AiApiMode::Responses => {
            assert_eq!(requests[0]["instructions"], requests[2]["instructions"]);
            assert!(tool_followup
                .iter()
                .any(|item| item["type"] == "function_call"
                    && item["id"] == "fc_1"
                    && item["call_id"] == "call-1"));
            assert!(tool_followup
                .iter()
                .any(|item| item["type"] == "function_call_output" && item["call_id"] == "call-1"));
            assert!(tool_followup
                .iter()
                .any(|item| item["type"] == "reasoning"
                    && item["encrypted_content"] == "encrypted-0"));
            assert!(next_turn
                .iter()
                .any(|item| item["type"] == "reasoning"
                    && item["encrypted_content"] == "encrypted-1"));
        }
    }
}

#[tokio::test]
async fn openai_chat_stream_preserves_cache_usage_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::ChatCompletions, true);
    let client = openai::Client::builder()
        .api_key("local-test")
        .base_url(&endpoint)
        .build()
        .unwrap();
    verify_cache_roundtrip(
        compat::chat_model(client, "test-model"),
        server,
        AiApiMode::ChatCompletions,
    )
    .await;
}

#[tokio::test]
async fn compatible_chat_stream_preserves_cache_usage_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::ChatCompletions, false);
    let client = openai::Client::builder()
        .api_key("local-test")
        .base_url(&endpoint)
        .build()
        .unwrap();
    verify_cache_roundtrip(
        compat::chat_model(client, "test-model"),
        server,
        AiApiMode::ChatCompletions,
    )
    .await;
}

#[tokio::test]
async fn openai_responses_stream_preserves_cache_usage_reasoning_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::Responses, true);
    let client = openai::Client::builder()
        .api_key("local-test")
        .base_url(&endpoint)
        .build()
        .unwrap();
    verify_cache_roundtrip(
        client.completion_model("test-model"),
        server,
        AiApiMode::Responses,
    )
    .await;
}
