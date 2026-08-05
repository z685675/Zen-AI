import { describe, expect, it } from 'vitest'

import { buildResearchWorkflowGuidance, detectResearchBuiltinSkillWorkflows } from '../researchWorkflows'

describe('research workflow routing', () => {
  it('routes a natural-language literature request to academic research', () => {
    const workflows = detectResearchBuiltinSkillWorkflows('请梳理近五年的文献和研究进展')

    expect(workflows.map((workflow) => workflow.skill)).toContain('$academic-research')
    expect(workflows.map((workflow) => workflow.skill)).not.toContain('$research-design')
  })

  it('routes a research idea to the design workflow', () => {
    const workflows = detectResearchBuiltinSkillWorkflows('帮我设计一个可复现的实验方案和研究方法')

    expect(workflows.map((workflow) => workflow.skill)).toContain('$research-design')
  })

  it('routes manuscript drafting to paper writing', () => {
    const workflows = detectResearchBuiltinSkillWorkflows('根据这些结果帮我完成论文写作，并标出缺少的实验结果')

    expect(workflows.map((workflow) => workflow.skill)).toContain('$paper-writing')
  })

  it('routes advisor and rebuttal requests to supervisor review', () => {
    const workflows = detectResearchBuiltinSkillWorkflows('请按导师视角审阅论文并准备返修意见')

    expect(workflows.map((workflow) => workflow.skill)).toContain('$supervisor-review')
  })

  it('returns no research guidance for unrelated requests', () => {
    expect(buildResearchWorkflowGuidance('帮我写一封简短的邀请邮件')).toBeUndefined()
  })

  it('keeps workflow names internal while providing quality rules', () => {
    const guidance = buildResearchWorkflowGuidance('帮我做一个系统综述')

    expect(guidance).toContain('<zen-ai-research-workflow-guidance>')
    expect(guidance).toContain('$academic-research')
    expect(guidance).toContain('Never invent papers')
    expect(guidance).toContain('Do not quote or expose this block')
  })
})
