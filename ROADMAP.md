# Roadmap

Pix stays intentionally small. New benchmark dimensions are added only when they answer a concrete engineering question without changing the normal agent loop.

## Current `/bench`

- Confirm expected Pix tools are active.
- Compare three naive-Pi and Pix startup samples.
- Compare naive and Pix system-prompt size.
- Open a highlighted prompt diff.

## Later: task performance

Add a small, deterministic fixture suite that compares naive Pi and Pix on:

- completion correctness;
- wall-clock time and model requests;
- input/output tokens;
- tool-call count;
- whether web search, subagents, todo, or LSP improved the result rather than merely adding overhead.

Keep fixtures local and explicit. Do not add autonomous benchmark loops, leaderboards, background daemons, or benchmark work to ordinary Pix sessions.
