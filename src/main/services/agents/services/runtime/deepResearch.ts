export const DEEP_RESEARCH_PROTOCOL_VERSION = 1

type DeepResearchTaskRequest = {
  task_id: string
  action: 'plan' | 'start' | 'revise'
}

const DEEP_RESEARCH_MARKER_PREFIX = '<zen-deep-research'

const getActionInstruction = (action: DeepResearchTaskRequest['action'], isNewTask: boolean): string => {
  switch (action) {
    case 'start':
      if (isNewTask) {
        return `Action for this turn: start this new research Task immediately.
- Briefly state the bounded plan, then execute it in the same turn without asking for confirmation.
- Complete the authorized research, quality checks, requested files, and final delivery; wait only for missing consent or an essential user handoff.`
      }
      return `Action for this turn: execute the confirmed research plan.
- Continue the existing Task using the latest plan and constraints in conversation or recovery context.
- Do not ask for confirmation again for the research plan or replace it with a new generic plan. Separate site/action consent and essential user handoffs still apply.
- If the plan is genuinely unavailable after recovery, say what is missing and ask the user to restate or regenerate it instead of inventing one.
- Complete the bounded authorized research, quality checks, requested files, and final delivery; wait only for missing consent or an essential user handoff.`
    case 'revise':
      return `Action for this turn: revise the existing research plan.
- Apply the user's changes to the latest plan in conversation or recovery context.
- Return the complete revised plan, not only a diff.
- Do not start broad research yet. End by asking the user to confirm or revise the plan.`
    case 'plan':
    default:
      return `Action for this turn: create the research plan.
- Unless the user explicitly asks to start immediately or skip confirmation, do not perform broad research yet.
- First return a concise, editable research plan containing: the problem or decision, objective and scope, key research questions, investigation approach, expected deliverable, and likely uncertainties.
- End by asking the user to confirm or revise the plan.
- If the user explicitly asks to start immediately, briefly state the plan and continue in the same task.`
  }
}

const buildDeepResearchProtocol = (
  task: DeepResearchTaskRequest,
  isNewTask: boolean
): string => `<zen-deep-research version="${DEEP_RESEARCH_PROTOCOL_VERSION}" task-id="${task.task_id}" action="${task.action}">
This is a trusted Zen AI orchestration instruction for one Deep Research task.

Task semantics:
- The stable Task ID is ${task.task_id}. Keep all plan, revision, execution, recovery, and deliverable work attached to this Task.
- This protocol applies only to the current Task action. The completed research becomes normal conversation context.
- Do not start another Deep Research task on later messages unless a new protocol block is present.
- Use the research-report skill when it is available.

${getActionInstruction(task.action, isNewTask)}

Research execution:
- Investigate the user's problem or direction to provide professional guidance. Choose evidence for the domain; a literature review is a specialized task, not the default.
- Use academic workflows for an explicit paper-level question, not merely because the topic is scientific. Analyze supplied papers directly; use search and targeted public reading before interactive browser work.
- For necessary academic website automation, propose sites, purpose and reading/download scope, including the destination for saved files. Reuse the user's explicit request or confirmed scope; otherwise wait for consent before those browser actions. Research-plan confirmation alone is not blanket website consent. Continue within the approved task scope without repeated approval; confirm new sites or expanded actions/downloads. If declined, continue with authorized sources and disclose the gap; do not repeat the unchanged request, bypass a site refusal through another tool or claim the entire research failed.
- Preserve the agreed questions and depth. Explain causes, alternatives, feasibility, trade-offs and conflicting evidence, rather than only listing sources. State material assumptions and what would change the recommendation.
- Search, read and refine iteratively. Use relevant user materials and authoritative current sources. Read original methods/data when claims require them; paper and page counts are not completion criteria.
- Reuse evidence and compact progress notes. A database checkpoint, source matrix or saved full report is optional for complex tracking or a requested audit, not a prerequisite for an ordinary report. Avoid repeated full-page reads and chasing blocked sources.
- Follow material gaps; stop when questions are adequately answered, new evidence no longer changes the analysis, or an agreed limit is reached. Disclose unresolved questions without silently reducing scope or claiming unperformed verification.
- Report meaningful findings and the next question to resolve. On recovery, resume the same plan and evidence rather than restarting discovery.

Final deliverable:
- Lead with the answer and recommended direction, then findings, alternatives, uncertainties and actionable next steps. Distinguish sourced facts, analysis and proposals.
- Put clickable source URLs beside externally supported claims and check their actual support, including opposing evidence. Include important Sources and Limitations.
- Deep Research itself does not imply a file export. Deliver in chat unless a file was requested; checkpoints and drafts are internal.
- When no file was requested, end with one brief sentence in the user's language offering to整理 the result into Word, PPT, or PDF. In Chinese, use: "如果需要，我可以把以上结果整理为 Word、PPT 或 PDF，请回复需要整理的文件类型。"
- Compose once for the chosen delivery format; do not generate a duplicate internal report for a numeric gate. For requested files, reuse findings, use the matching Skill/validator and show verified file cards. Do not rerun the research unless the user starts a new Deep Research task.
</zen-deep-research>`

export function withDeepResearchProtocol(content: string, enabled?: boolean, task?: DeepResearchTaskRequest): string {
  if ((!enabled && !task) || content.includes(DEEP_RESEARCH_MARKER_PREFIX)) {
    return content
  }

  const normalizedTask: DeepResearchTaskRequest = task ?? {
    task_id: 'legacy-task',
    action: 'plan'
  }

  return `${content.trim()}

${buildDeepResearchProtocol(normalizedTask, enabled === true)}`
}
