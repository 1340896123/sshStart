use super::*;
use rig::{
    message::{AssistantContent, AssistantMessage, CallId, ToolName},
    tool::{DynamicTool, ToolOutput},
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
        Message::Assistant(AssistantMessage::new(vec![
            AssistantContent::reasoning("check uptime"),
            AssistantContent::tool_call(
                "call-1",
                ToolName::new("read_file").unwrap(),
                json!({"path": "/proc/uptime"}),
            ),
        ])),
        Message::tool_result(
            CallId::from_wire("call-1"),
            ToolName::new("read_file").unwrap(),
            "123.45",
        ),
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
                Message::tool_result(
                    CallId::from_wire("id"),
                    ToolName::new("read_file").unwrap(),
                    "result",
                ),
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
    usage.input_tokens = Some(4000);
    usage.output_tokens = Some(200);
    usage.total_tokens = Some(4200);
    usage.cached_input_tokens = Some(3600);
    let snapshot = AiTokenUsage::from_rig(usage, 2, 2500);
    assert_eq!(snapshot.input_tokens, 4000);
    assert_eq!(snapshot.cached_tokens, 3600);
    assert_eq!(snapshot.context_tokens, 2500);
    assert_eq!(snapshot.requests, 2);
    assert!(!AiTokenUsage::from_rig(Usage::new(), 1, 0).available);
}

#[test]
fn reported_zero_usage_is_distinct_from_missing_usage() {
    let zero = AiTokenUsage::from_rig(
        Usage::new()
            .input_tokens(0)
            .output_tokens(0)
            .total_tokens(0),
        1,
        0,
    );
    assert!(zero.available);
    assert_eq!(zero.total_tokens, 0);
    assert!(!AiTokenUsage::from_rig(Usage::new(), 1, 0).available);
}

#[test]
fn response_cache_identity_survives_turns_and_separates_conversations_and_servers() {
    let key = |server, conversation| {
        request_options(AiApiMode::Responses, server, Some(conversation))
            .cache_key
            .unwrap()
    };
    let first = key("server-1", "conversation-1");
    assert_eq!(first, key("server-1", "conversation-1"));
    assert_ne!(first, key("server-1", "conversation-2"));
    assert_ne!(first, key("server-2", "conversation-1"));
    assert!(first.starts_with("sshstar-"));
    assert!(first.len() <= 64);
    assert!(!first.contains("conversation-1"));
}

#[test]
fn chat_and_legacy_clients_do_not_send_a_response_cache_identity() {
    for conversation in [None, Some(""), Some("  ")] {
        assert!(
            request_options(AiApiMode::Responses, "server", conversation)
                .cache_key
                .is_none()
        );
    }
    assert!(
        request_options(AiApiMode::ChatCompletions, "server", Some("conversation"))
            .cache_key
            .is_none()
    );
}

// Exercise Rig's actual streaming transport, tool loop, and serialized requests.
// No API credentials or SSH server are needed.
fn mock_provider(
    mode: AiApiMode,
    standard_cache_details: bool,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    mock_provider_with_tools(mode, standard_cache_details, true)
}

fn mock_provider_with_tools(
    mode: AiApiMode,
    standard_cache_details: bool,
    with_tools: bool,
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
            // Windows can inherit the listener's nonblocking mode.
            socket.set_nonblocking(false).unwrap();
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
                    chat_stream_body(if with_tools { turn } else { 1 }, usage)
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
    effort: AiReasoningEffort,
    expected_temperature: Option<f64>,
) where
    M: Into<DynModel<Completion>>,
{
    let model: DynModel<Completion> = model.into();
    let model_id = model.id().unwrap().to_string();
    let make_agent = || {
        agent_builder(
            model.clone(),
            0.25,
            effort,
            request_options(mode, "test-server", Some("test-conversation")),
        )
        .preamble("stable instructions")
        .max_tokens(4096)
        .dynamic_tools(vec![DynamicTool::new(
            ToolName::new("inspect").unwrap(),
            "inspect",
            json!({"type": "object", "properties": {}}),
            |_| Box::pin(async { Ok(ToolOutput::text("123.45")) }),
        )])
        .build()
    };
    let agent = make_agent();
    let mut stream = agent.prompt("inspect").max_turns(2).stream();
    let mut response = None;
    let mut calls = Vec::new();
    let mut text = String::new();
    let mut reasoning = String::new();
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        match item.unwrap() {
            MultiTurnStreamItem::FinalResponse(result) => response = Some(result),
            MultiTurnStreamItem::CompletionCall(call) => calls.push(call.usage),
            MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Text {
                text: delta,
                ..
            })) => text.push_str(&delta),
            MultiTurnStreamItem::StreamAssistantItem(Item::Event(StreamEvent::Reasoning {
                text: delta,
                ..
            })) => reasoning.push_str(&delta),
            _ => {}
        }
    }
    let response = response.unwrap();
    assert_eq!(response.output(), "running");
    assert_eq!(text, "running");
    if mode == AiApiMode::Responses {
        assert!(reasoning.contains("check server"));
    }
    assert_eq!(calls.len(), 2);
    assert_eq!(response.usage.input_tokens, Some(4500));
    assert_eq!(response.usage.output_tokens, Some(200));
    assert_eq!(response.usage.total_tokens, Some(4700));
    assert_eq!(response.usage.cached_input_tokens, Some(4100));
    assert_eq!(response.usage.reasoning_tokens, Some(60));
    let snapshot = AiTokenUsage::from_rig(
        response.usage,
        calls.len() as u32,
        calls.last().unwrap().input_tokens.unwrap_or(0),
    );
    assert_eq!(snapshot.context_tokens, 2500);
    let output = response.output();
    let transcript: Vec<_> = response.messages.into_iter().skip(1).collect();
    let (prompt, history) = split_messages(vec![
        input("user", "inspect", None),
        input(
            "assistant",
            &output,
            Some(serde_json::to_value(transcript).unwrap()),
        ),
        input("user", "continue", None),
    ])
    .unwrap();
    let agent = make_agent();
    let mut stream = agent.prompt(prompt).history(history).stream();
    let mut second_response = None;
    while let Some(item) = futures::StreamExt::next(&mut stream).await {
        if let MultiTurnStreamItem::FinalResponse(response) = item.unwrap() {
            second_response = Some(response);
        }
    }
    let second_response = second_response.unwrap();
    assert_eq!(second_response.usage.cached_input_tokens, Some(2500));
    assert_eq!(second_response.usage.reasoning_tokens, Some(10));
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
        let actual_effort = match mode {
            AiApiMode::ChatCompletions => &request["reasoning_effort"],
            AiApiMode::Responses => &request["reasoning"]["effort"],
        };
        if effort == AiReasoningEffort::Auto {
            assert!(actual_effort.is_null());
        } else {
            assert_eq!(*actual_effort, json!(effort));
        }
        assert_eq!(request["stream"], true);
        assert_eq!(request["model"], model_id);
        assert_eq!(
            request.get("temperature"),
            expected_temperature.map(|value| json!(value)).as_ref()
        );
        let cache_key = request_options(mode, "test-server", Some("test-conversation")).cache_key;
        assert_eq!(
            request.get("prompt_cache_key"),
            cache_key.as_ref().map(|key| json!(key)).as_ref()
        );
        let tool = &request["tools"][0];
        assert_eq!(tool["type"], "function");
        match mode {
            AiApiMode::ChatCompletions => {
                assert_eq!(tool["function"]["name"], "inspect");
                assert_eq!(request["stream_options"]["include_usage"], true);
                assert!(request.get("input").is_none());
                assert!(request.get("instructions").is_none());
                assert!(request.get("reasoning").is_none());
                assert!(request.get("max_output_tokens").is_none());
                let cap = if model_id == "gpt-6-sol" {
                    "max_completion_tokens"
                } else {
                    "max_tokens"
                };
                assert_eq!(request[cap], 4096);
            }
            AiApiMode::Responses => {
                assert_eq!(request["max_output_tokens"], 4096);
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
async fn sol_chat_without_tools_sends_chat_fields_and_preserves_history() {
    for effort in [
        AiReasoningEffort::Auto,
        AiReasoningEffort::Low,
        AiReasoningEffort::Medium,
        AiReasoningEffort::High,
        AiReasoningEffort::Xhigh,
    ] {
        let (endpoint, server) = mock_provider_with_tools(AiApiMode::ChatCompletions, true, false);
        let client = openai::OpenAIConfig::new("local-test")
            .with_base_url(endpoint)
            .client();
        let agent = agent_builder(
            client.chat("gpt-6.1-sol"),
            0.25,
            effort,
            GenerationOptions::default(),
        )
        .preamble("stable instructions")
        .max_tokens(4096)
        .build();
        let mut history = Vec::new();
        for prompt in ["hello", "continue", "again"] {
            let mut stream = agent.prompt(prompt).history(history.clone()).stream();
            let mut response = None;
            while let Some(item) = futures::StreamExt::next(&mut stream).await {
                if let MultiTurnStreamItem::FinalResponse(result) = item.unwrap() {
                    response = Some(result);
                }
            }
            let response = response.unwrap();
            assert_eq!(response.output(), "running");
            history.extend(response.messages);
        }
        let requests = server.join().unwrap();
        for request in &requests {
            assert_eq!(request["model"], "gpt-6.1-sol");
            assert_eq!(request["max_completion_tokens"], 4096);
            assert_eq!(request["stream"], true);
            assert_eq!(request["stream_options"]["include_usage"], true);
            assert_eq!(
                request.get("reasoning_effort"),
                (effort != AiReasoningEffort::Auto)
                    .then(|| json!(effort))
                    .as_ref()
            );
            assert!(request["messages"].as_array().unwrap().len() >= 2);
            for field in [
                "input",
                "instructions",
                "reasoning",
                "max_output_tokens",
                "max_tokens",
                "temperature",
                "top_p",
                "logprobs",
                "tools",
                "tool_choice",
            ] {
                assert!(request.get(field).is_none(), "unexpected field: {field}");
            }
        }
        let first = requests[0]["messages"].as_array().unwrap();
        let next = requests[1]["messages"].as_array().unwrap();
        assert_eq!(&next[..first.len()], first);
        assert!(next.iter().any(|message| message["role"] == "assistant"));
    }
}

#[test]
fn chat_tool_compatibility_reports_actionable_configuration_errors() {
    let client = openai::OpenAIConfig::new("local-test").client();
    let sol: DynModel<Completion> = client.chat("gpt-6.1-sol").into();
    let error = validate_tool_calling(
        &sol,
        AiApiMode::ChatCompletions,
        AiReasoningEffort::Auto,
        true,
    )
    .unwrap_err();
    assert!(error.contains("Responses"));
    assert!(error.contains("gpt-6.1-sol"));
    assert!(validate_tool_calling(
        &sol,
        AiApiMode::ChatCompletions,
        AiReasoningEffort::High,
        false,
    )
    .is_ok());
    assert!(
        validate_tool_calling(&sol, AiApiMode::Responses, AiReasoningEffort::High, true,).is_ok()
    );
    for name in ["gpt-6-sol", "gpt-6-luna"] {
        let model: DynModel<Completion> = client.chat(name).into();
        for effort in [AiReasoningEffort::Auto, AiReasoningEffort::High] {
            let error = validate_tool_calling(&model, AiApiMode::ChatCompletions, effort, true)
                .unwrap_err();
            assert!(error.contains("none"));
            assert!(error.contains("Responses"));
        }
        assert!(validate_tool_calling(
            &model,
            AiApiMode::ChatCompletions,
            AiReasoningEffort::None,
            true,
        )
        .is_ok());
    }
    for name in ["gpt-4.1", "custom-model"] {
        assert!(validate_tool_calling(
            &client.chat(name).into(),
            AiApiMode::ChatCompletions,
            AiReasoningEffort::Auto,
            true,
        )
        .is_ok());
    }
}

#[tokio::test]
async fn openai_chat_stream_preserves_cache_usage_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::ChatCompletions, true);
    let client = openai::OpenAIConfig::new("local-test")
        .with_base_url(&endpoint)
        .client();
    verify_cache_roundtrip(
        client.chat("test-model"),
        server,
        AiApiMode::ChatCompletions,
        AiReasoningEffort::Auto,
        Some(0.25),
    )
    .await;
}

#[tokio::test]
async fn compatible_chat_stream_preserves_cache_usage_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::ChatCompletions, false);
    let client = openai::OpenAIConfig::new("local-test")
        .with_base_url(&endpoint)
        .client();
    verify_cache_roundtrip(
        client.chat("test-model"),
        server,
        AiApiMode::ChatCompletions,
        AiReasoningEffort::Auto,
        Some(0.25),
    )
    .await;
}

#[tokio::test]
async fn openai_responses_stream_preserves_cache_usage_reasoning_and_tool_history() {
    let (endpoint, server) = mock_provider(AiApiMode::Responses, true);
    let client = openai::OpenAIConfig::new("local-test")
        .with_base_url(&endpoint)
        .client();
    verify_cache_roundtrip(
        client.responses("test-model"),
        server,
        AiApiMode::Responses,
        AiReasoningEffort::Auto,
        Some(0.25),
    )
    .await;
}

#[tokio::test]
async fn reasoning_effort_reaches_both_provider_wires() {
    for mode in [AiApiMode::ChatCompletions, AiApiMode::Responses] {
        for effort in [
            AiReasoningEffort::None,
            AiReasoningEffort::Minimal,
            AiReasoningEffort::Low,
            AiReasoningEffort::Medium,
            AiReasoningEffort::High,
            AiReasoningEffort::Xhigh,
        ] {
            let (endpoint, server) = mock_provider(mode, true);
            let client = openai::OpenAIConfig::new("local-test")
                .with_base_url(endpoint)
                .client();
            match mode {
                AiApiMode::ChatCompletions => {
                    verify_cache_roundtrip(
                        client.chat("test-model"),
                        server,
                        mode,
                        effort,
                        Some(0.25),
                    )
                    .await
                }
                AiApiMode::Responses => {
                    verify_cache_roundtrip(
                        client.responses("test-model"),
                        server,
                        mode,
                        effort,
                        Some(0.25),
                    )
                    .await
                }
            }
        }
    }
}

#[tokio::test]
async fn reasoning_models_omit_temperature_through_tool_calls_and_followups() {
    use AiApiMode::{ChatCompletions, Responses};
    use AiReasoningEffort::{Auto, High, Low, None as Off, Xhigh};

    for (mode, model, effort, temperature) in [
        (Responses, "gpt-6.1-sol", Auto, None),
        (Responses, "gpt-6.1-sol", Low, None),
        (Responses, "gpt-6.1-sol", Xhigh, None),
        (Responses, "gpt-6-sol", Auto, None),
        (Responses, "gpt-6-sol", High, None),
        (Responses, "gpt-6-sol", Off, Some(0.25)),
        (ChatCompletions, "gpt-6-sol", Off, Some(0.25)),
        (Responses, "gpt-4.1", Auto, Some(0.25)),
        (ChatCompletions, "gpt-4.1", Auto, Some(0.25)),
    ] {
        let (endpoint, server) = mock_provider(mode, true);
        let client = openai::OpenAIConfig::new("local-test")
            .with_base_url(endpoint)
            .client();
        match mode {
            ChatCompletions => {
                verify_cache_roundtrip(client.chat(model), server, mode, effort, temperature).await
            }
            Responses => {
                verify_cache_roundtrip(client.responses(model), server, mode, effort, temperature)
                    .await
            }
        }
    }
}

#[test]
fn restores_041_tool_history_with_distinct_provider_call_ids() {
    let legacy = json!([
        {"role": "assistant", "id": "reply-1", "content": [
            {"id": "rs-1", "content": [{"type": "text", "content": {"text": "inspect uptime"}}]},
            {"id": "fc-1", "call_id": "call-1", "function": {"name": "read_file", "arguments": {"path": "/proc/uptime"}}}
        ]},
        {"role": "user", "content": [{"type": "toolresult", "id": "fc-1", "call_id": "call-1", "content": [{"type": "text", "text": "123.45"}]}]},
        {"role": "assistant", "id": "reply-2", "content": [{"text": "running"}]}
    ]);
    let (_, history) = split_messages(vec![
        input("user", "inspect", None),
        input("assistant", "running", Some(legacy)),
        input("user", "continue", None),
    ])
    .unwrap();
    assert_eq!(history.len(), 4);
    let Message::Assistant(turn) = &history[1] else {
        panic!("assistant turn")
    };
    assert!(
        matches!(&turn.content[0], AssistantContent::Reasoning(block) if block.text == "inspect uptime")
    );
    let call = turn.tool_calls().next().unwrap();
    assert_eq!(call.id.wire(), "call-1");
    let Message::User { content } = &history[2] else {
        panic!("tool result")
    };
    assert!(
        matches!(&content[0], rig::message::UserContent::ToolResult(result)
        if result.call == call.id && result.name == "read_file")
    );
}
