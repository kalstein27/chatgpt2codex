export const CHATGPT_OPERATION_APPROVAL_USER_PROMPTS = {
  allow: "승인 완료. 승인된 mutation은 다시 호출하지 말고 연결된 작업 상태를 status-only로 확인한 뒤 기존 작업의 다음 단계를 계속 진행해.",
  deny: "거절 상태 확인",
} as const;

export const CHATGPT_STANDARD_CONSENT_USER_PROMPTS = {
  allowProject: "이 프로젝트에서 허용 완료",
  allow: "허용 완료",
  deny: "거절 완료",
} as const;
