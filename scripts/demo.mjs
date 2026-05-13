#!/usr/bin/env node
// Local demo: starts the viewer with seed content and prints pending
// questions as they arrive. Reply via curl from another shell:
//
//   curl -s -X POST http://localhost:<port>/api/answer \
//     -H 'content-type: application/json' \
//     -d '{"id": 1, "answer": "It is a **pangram** — every letter at least once."}'
//
import {
  startWebServer,
  pushContent,
  openBrowser,
  getPort,
  drainPendingQuestions,
  drainPendingSelections,
} from "../dist/web.js";

const SEED = `# Q&A Demo

Highlight any text below, click **Ask Claude**, type a question, and submit.
This terminal will print each question with its \`id\`. To reply, post to the
viewer's HTTP endpoint from another shell:

\`\`\`bash
curl -s -X POST http://localhost:PORT/api/answer \\
  -H 'content-type: application/json' \\
  -d '{"id": 1, "answer": "It is a **pangram** — every letter at least once."}'
\`\`\`

Your reply renders live in the viewer's Q&A panel.

---

## The quick brown fox

The quick brown fox jumps over the lazy dog. This pangram contains every
letter of the English alphabet at least once, and is commonly used to test
typewriters, fonts, and keyboards.

## Photosynthesis

Plants convert sunlight, water, and carbon dioxide into glucose and oxygen
via chlorophyll in their leaves. The chemical equation is:

$$6CO_2 + 6H_2O \\rightarrow C_6H_{12}O_6 + 6O_2$$

## A flow

\`\`\`mermaid
flowchart LR
  Highlight --> Ask --> Server --> Claude --> Answer --> Panel
\`\`\`
`;

await startWebServer();
const port = getPort();
pushContent(SEED.replace("PORT", String(port)), "/");
await openBrowser("/");

console.log(`\nViewer:  http://localhost:${port}`);
console.log(`Reply:   curl -s -X POST http://localhost:${port}/api/answer \\`);
console.log(`           -H 'content-type: application/json' \\`);
console.log(`           -d '{"id": 1, "answer": "**Hi!**"}'\n`);
console.log("Waiting for questions... (Ctrl-C to stop)\n");

setInterval(() => {
  const questions = drainPendingQuestions();
  for (const q of questions) {
    console.log(`--- 💬 Question id=${q.id} (path ${q.path}) ---`);
    console.log(`  Highlight: ${JSON.stringify(q.selection.slice(0, 200))}`);
    console.log(`  Question:  ${q.question}`);
    console.log(`  Reply:     curl -s -X POST http://localhost:${port}/api/answer -H 'content-type: application/json' -d '{"id": ${q.id}, "answer": "..."}'`);
    console.log("");
  }
  const quotes = drainPendingSelections();
  for (const s of quotes) {
    console.log(`--- 📎 Quote id=${s.id} (path ${s.path}) — context only ---`);
    console.log(`  Highlight: ${JSON.stringify(s.selection.slice(0, 200))}`);
    if (s.comment) console.log(`  Comment:   ${s.comment}`);
    console.log("");
  }
}, 500);
