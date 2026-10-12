#!/usr/bin/env node
// Deterministic stand-in for the `pi` CLI that pi-subagents' background runner spawns
// (selected through PI_SUBAGENT_PI_BINARY). No model is called: the task file decides
// how long the child "works" (`sleep:<ms>`), and every start and finish is logged.
import { appendFileSync, readFileSync } from 'node:fs';

const taskFile = process.argv.slice(2).find(arg => arg.startsWith('@'))?.slice(1);
const task = taskFile ? readFileSync(taskFile, 'utf8') : '';
const name = task.match(/fake-task:(\w+)/)?.[1] ?? 'unknown';
const ms = Number(task.match(/sleep:(\d+)/)?.[1] ?? 50);
const log = event => appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ event, name, pid: process.pid })}\n`);
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);

log('start');
emit({ type: 'agent_start' });
setTimeout(() => {
  log('finish');
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `done ${name}` }], model: 'fake', usage: { input: 1, output: 1 }, stopReason: 'stop' } });
  emit({ type: 'agent_end', messages: [] });
  process.exit(0);
}, ms);
