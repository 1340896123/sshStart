use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AiContextBreakdown {
    pub(super) system_prompt_tokens: u64,
    pub(super) tool_definition_tokens: u64,
    pub(super) conversation_tokens: u64,
}

#[derive(Clone, Copy)]
pub(super) struct ContextEstimate {
    system: u64,
    tools: u64,
}

fn estimate_tokens(text: &str) -> u64 {
    let (ascii, unicode) = text.chars().fold((0u64, 0u64), |(ascii, unicode), ch| {
        if ch.is_ascii() {
            (ascii + 1, unicode)
        } else {
            (ascii, unicode + 1)
        }
    });
    // Provider tokenizers differ; count ASCII at ~4 chars/token and Unicode at ~1.5 tokens/char.
    (ascii + unicode * 6).div_ceil(4)
}

impl ContextEstimate {
    pub(super) fn new(system_prompt: &str, tool_definitions: &str) -> Self {
        Self {
            system: estimate_tokens(system_prompt),
            tools: estimate_tokens(tool_definitions),
        }
    }

    pub(super) fn breakdown(self, total: u64) -> AiContextBreakdown {
        let overhead = self.system + self.tools;
        let (system, tools) = if overhead > total {
            let system = (total as u128 * self.system as u128 / overhead as u128) as u64;
            (system, total - system)
        } else {
            (self.system, self.tools)
        };
        AiContextBreakdown {
            system_prompt_tokens: system,
            tool_definition_tokens: tools,
            conversation_tokens: total - system - tools,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_breakdown_preserves_reported_totals_and_handles_small_windows() {
        let estimate = ContextEstimate::new("system prompt", "tool schema");
        for total in [0, 1, 5, 100, 1_000_000] {
            let breakdown = estimate.breakdown(total);
            assert_eq!(
                breakdown.system_prompt_tokens
                    + breakdown.tool_definition_tokens
                    + breakdown.conversation_tokens,
                total
            );
        }
        let no_tools = ContextEstimate::new("系统提示", "").breakdown(100);
        assert_eq!(no_tools.tool_definition_tokens, 0);
        assert!(no_tools.system_prompt_tokens > 0);
        assert!(no_tools.conversation_tokens > 0);
    }
}
