use rig::{
    client::{DebugExt, Provider},
    completion::{GetTokenUsage, Usage},
    providers::openai,
};
use serde::{Deserialize, Serialize};

// Keep Rig's OpenAI transport and request conversion, while accepting usage
// counters also returned by compatible providers such as DeepSeek.
#[derive(Clone, Debug)]
pub(super) struct ChatProvider;

impl DebugExt for ChatProvider {}

impl Provider for ChatProvider {
    type Builder = openai::OpenAICompletionsExtBuilder;
    const VERIFY_PATH: &'static str = "/models";
}

impl openai::OpenAICompatibleProvider for ChatProvider {
    const PROVIDER_NAME: &'static str = "openai";
    type StreamingUsage = ChatUsage;
    type Response = openai::CompletionResponse;
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub(super) struct ChatUsage {
    #[serde(flatten)]
    standard: openai::Usage,
    #[serde(default)]
    prompt_cache_hit_tokens: u64,
}

impl GetTokenUsage for ChatUsage {
    fn token_usage(&self) -> Usage {
        let mut usage = self.standard.token_usage();
        if self.standard.prompt_tokens_details.is_none() {
            usage.cached_input_tokens = self.prompt_cache_hit_tokens;
        }
        usage
    }
}

pub(super) fn chat_model(
    client: openai::Client,
    model: &str,
) -> openai::GenericCompletionModel<ChatProvider> {
    openai::GenericCompletionModel::new(client.with_ext(ChatProvider), model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_compatible_cache_hits_without_changing_total_usage() {
        let usage: ChatUsage = serde_json::from_value(json!({
            "prompt_tokens": 2000, "completion_tokens": 100, "total_tokens": 2100,
            "prompt_cache_hit_tokens": 1800, "prompt_cache_miss_tokens": 200,
            "completion_tokens_details": { "reasoning_tokens": 40 }
        }))
        .unwrap();
        let usage = usage.token_usage();
        assert_eq!(usage.input_tokens, 2000);
        assert_eq!(usage.output_tokens, 100);
        assert_eq!(usage.total_tokens, 2100);
        assert_eq!(usage.cached_input_tokens, 1800);
        assert_eq!(usage.reasoning_tokens, 40);
    }

    #[test]
    fn standard_cache_details_take_precedence_including_zero() {
        for cached in [0, 1500] {
            let usage: ChatUsage = serde_json::from_value(json!({
                "prompt_tokens": 2000, "completion_tokens": 100, "total_tokens": 2100,
                "prompt_tokens_details": { "cached_tokens": cached },
                "prompt_cache_hit_tokens": 1800
            }))
            .unwrap();
            assert_eq!(usage.token_usage().cached_input_tokens, cached);
        }
    }

    #[test]
    fn missing_cache_metrics_are_zero() {
        let usage: ChatUsage = serde_json::from_value(json!({
            "prompt_tokens": 2000, "completion_tokens": 100, "total_tokens": 2100
        }))
        .unwrap();
        assert_eq!(usage.token_usage().cached_input_tokens, 0);
        assert!(!ChatUsage::default().token_usage().has_values());
    }
}
