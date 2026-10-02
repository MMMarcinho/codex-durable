import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-codex 1.0\n');
  process.exit(0);
}
const value = (flag) => args[args.indexOf(flag) + 1];
const cwd = value('--cd');
const finalPath = value('--output-last-message');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'edit solution.txt' } })}\n`);
await writeFile(join(cwd, 'solution.txt'), `fixed: ${prompt.trim()}\n`);
if (prompt.includes('FAKE:delay')) await new Promise((resolve) => setTimeout(resolve, 5000));
if (prompt.includes('FAKE:fail')) process.exit(7);
const answer = 'Fixed the task.';
await writeFile(finalPath, answer);
process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: answer } })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } })}\n`);
