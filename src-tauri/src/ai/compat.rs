use rig::message::{
    AssistantContent, AssistantMessage, Message, ToolName, ToolResultContent, UserContent,
};
use serde_json::Value;
use std::collections::HashMap;

// Rig 0.45 changed the persisted message schema. Recover canonical text and
// tool exchanges from 0.41; opaque provider payloads require a known origin
// and must not be replayed as if a new model had produced them.
pub(super) fn restore_messages(value: Value) -> Option<Vec<Message>> {
    if let Ok(messages) = serde_json::from_value(value.clone()) {
        return Some(messages);
    }
    let mut calls = HashMap::new();
    let mut messages = Vec::new();
    for message in value.as_array()? {
        let parts = message.get("content")?.as_array()?;
        match message.get("role")?.as_str()? {
            "assistant" => {
                let mut content = Vec::new();
                for part in parts {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        content.push(AssistantContent::text(text));
                    } else if let Some(function) = part.get("function") {
                        let old_id = part.get("id")?.as_str()?;
                        let wire_id = part
                            .get("call_id")
                            .and_then(Value::as_str)
                            .unwrap_or(old_id);
                        let call = AssistantContent::tool_call(
                            wire_id,
                            ToolName::new(function.get("name")?.as_str()?).ok()?,
                            function.get("arguments")?.clone(),
                        );
                        if let AssistantContent::ToolCall(call) = &call {
                            calls.insert(
                                old_id.to_string(),
                                (call.id.clone(), call.function.name.clone()),
                            );
                        }
                        content.push(call);
                    } else {
                        let blocks = part.get("content")?.as_array()?;
                        let text = blocks
                            .iter()
                            .filter_map(|block| match block.get("type")?.as_str()? {
                                "text" => block.pointer("/content/text")?.as_str(),
                                "summary" => block.get("content")?.as_str(),
                                _ => None,
                            })
                            .collect::<Vec<_>>()
                            .join("\n");
                        content.push(AssistantContent::reasoning(text));
                    }
                }
                messages.push(Message::Assistant(AssistantMessage::new(content)));
            }
            "user" => {
                let mut content = Vec::new();
                for part in parts {
                    if part.get("type")?.as_str()? == "toolresult" {
                        let (call, name) = calls.get(part.get("id")?.as_str()?)?;
                        let result: Vec<ToolResultContent> =
                            serde_json::from_value(part.get("content")?.clone()).ok()?;
                        content.push(UserContent::tool_result(call.clone(), name.clone(), result));
                    } else {
                        content.push(serde_json::from_value(part.clone()).ok()?);
                    }
                }
                messages.push(Message::User { content });
            }
            _ => return None,
        }
    }
    Some(messages)
}
