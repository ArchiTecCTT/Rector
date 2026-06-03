# Chunk 6 — Chat API Vertical Shell

Expose chat-first endpoints and a minimal UI shell while keeping orchestration details behind the user-facing conversation.

## Metadata

- chunk: 006
- labels: roadmap, chunk:006, api, chat, ui, difficulty:intermediate
- difficulty: intermediate
- good first issue: false
- milestone: v0.1.0-alpha
- project board status: Ready

## Acceptance criteria

- [ ] Users can create and open conversations through chat-first endpoints.
- [ ] Sending a message produces an assistant response and visible run status metadata.
- [ ] Optional trace/events visibility exists without making agent orchestration the primary UX.

## Test commands

- `npm test -- tests/chatApi.test.ts tests/api.test.ts`
- `npm test`
- `npm run build`

## Project board / Linear sync

- Add to the GitHub project board manually in **Ready** for milestone **v0.1.0-alpha**.
- Linear sync is disabled by default for open-source contributors.
- If maintainers sync manually, use team **RECTOR**, priority **medium**, and labels: roadmap, chunk:006, api, chat, ui, difficulty:intermediate.
- Do not paste credentials, API keys, or private board URLs into this issue.
