use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AiApprovalPolicy {
    #[default]
    Request,
    Reviewer,
    FullAccess,
}

impl AiApprovalPolicy {
    pub(super) fn instructions(self) -> &'static str {
        match self {
            Self::Request => "当前审批策略：请求批准。需要审批的工具调用由运行时提交给用户；直接调用工具即可，不要先在回复中重复询问同一项授权。",
            Self::Reviewer => "当前审批策略：替我审批。需要审批的工具调用由审核模型结合用户请求与已有授权评估；直接调用工具，不要额外要求人工批准。",
            Self::FullAccess => "当前审批策略：完全访问。用户已授权在当前任务范围内使用所有已启用工具，包括执行命令、写入、传输和服务变更；无需人工审批或审核模型批准，允许变更工具的总开关不限制本模式。不要因操作涉及写入、sudo、安装、重启或风险提示就停下来要求确认。",
        }
    }
}
