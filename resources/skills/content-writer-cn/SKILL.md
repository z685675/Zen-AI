---
name: content-writer-cn
description: Create, rewrite, validate, polish, and adapt Chinese content for WeChat articles, Xiaohongshu posts, short video scripts, product marketing copy, social posts, brand copy, headlines, outlines, and campaign content. Use when the user asks for 中文创作, 公众号, 小红书, 短视频脚本, 文案, 改写, 润色, 标题, 种草, 营销内容, or Chinese content with a specific tone.
---

# Content Writer CN

Create Chinese content that is clear, useful, and platform-aware.

## Operating Rules

- Identify platform, audience, goal, tone, length, and conversion action.
- Do not produce generic motivational copy. Make the angle specific.
- Use natural Chinese. Avoid translation-style phrasing, inflated adjectives, and empty slogans.
- Offer 2-3 title or hook options when useful.
- Preserve facts and constraints from the user.
- Run bundled scripts with `mcp__assistant__python_execute`; do not probe or install into system Python.

## Bundled Resources

- Read `references/platform-patterns.md` when adapting for WeChat, Xiaohongshu, short video, or product marketing.
- Use `scripts/check_cn_copy.py` for commercial copy, important public posts, long drafts, or when the user asks for a more premium/professional result.
- Use `assets/copy-templates/` as starting structures when the user asks for:
  - `wechat-article.md` for 公众号文章.
  - `xiaohongshu-post.md` for 小红书笔记.
  - `video-script.md` for short video scripts.

## Platform Patterns

- **WeChat article**: strong opening, clear structure, useful examples, smooth transitions, ending with a concrete takeaway.
- **Xiaohongshu**: direct hook, personal or scenario-based angle, short paragraphs, practical bullets, restrained emoji only if the user wants it.
- **Short video script**: 3-second hook, scene beats, narration, visual instructions, ending action.
- **Product copy**: pain point, product value, proof, objection handling, call to action.

For quality checks:

Call `mcp__assistant__python_execute` with `script_path: "<skill-root>/scripts/check_cn_copy.py"` and `arguments: ["draft.md", "--platform", "xiaohongshu"]`.

## Rewrite Modes

- clearer and shorter
- more professional
- warmer and more conversational
- more persuasive
- more premium
- more direct for conversion

## Quality Bar

- The first sentence should earn attention.
- Each paragraph should move the reader forward.
- Avoid vague phrases like "赋能", "全场景", "深度使能", and empty slogans unless context requires them.
- Headlines should be concrete and testable.
- End with a clear next action or memorable point.
