# Roadmap

## 1. Reproducible benchmark

Build a small, out-of-the-box suite that compares vanilla Pi, Pix, and a broader agent system on realistic coding tasks. Track:

- task success and reliability;
- latency;
- input, output, cache-read, and cache-write tokens;
- estimated cost;
- prompt overhead;
- each Pix capability in isolation where practical.

Publish the task definitions, environment, raw results, and summary so others can reproduce the comparison. Start with 10–20 representative tasks rather than building a large benchmark platform.

## 2. Product demonstration

Create one concise demonstration before building a dedicated website:

- a 45–60 second terminal video;
- one polished overview image;
- short web-research, subagent, todo, and LSP scenarios;
- direct before/after examples in the README.

Add the best preview to the package gallery metadata in `package.json`.

## 3. Distribution and community launch

- Publish a scoped npm package after npm credentials are configured.
- Verify the listing and preview on the Pi package gallery.
- Refresh the `awesome-pi-coding-agent` entry.
- Announce the reproducible benchmark and demo in the Pi community, then share them through broader developer channels.

## 4. Dedicated website

Build a small website only after the benchmark and demonstration establish what it needs to communicate. Lead with Pix's position: Pi equipped with practical essentials, without the prompt and operational weight of a broad agent platform.
