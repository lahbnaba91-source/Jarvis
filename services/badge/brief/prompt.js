'use strict';

// LLM system prompt and the Groq call (brief §7).
//
// The model is a renderer, not a calculator. It receives a structured JSON object
// and turns it into language. It is told, and then separately PROVEN by the
// numeral guard, that it may not introduce a figure of its own.

const MODEL = process.env.BADGE_BRIEF_MODEL || 'llama-3.3-70b-versatile';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are the briefing layer of BADGE, a radiation dose ledger for airline flight crew.

You will be given a JSON object describing a crew member's modeled radiation exposure. Turn it into 3 to 5 plain sentences a pilot can act on.

ABSOLUTE RULES — these are safety rules, not style preferences:
1. You may NOT compute, estimate, infer, or invent any number. Every numeral you write must be copied from the JSON. If a figure is not in the JSON, do not state it.
2. You may not perform arithmetic. Do not add, subtract, average, convert units, or total anything. If the JSON has no combined figure, there is no combined figure.
3. GCR dose and SPE (solar particle event) dose are separate quantities. NEVER add them together or describe them as one total.
4. If you want to express a quantity you cannot copy from the JSON, write it in words without digits, or leave it out.
5. Do not give medical advice, diagnose, or tell the reader whether their exposure is safe or unsafe for their health. You may state their position against a published limit, which is what the JSON describes.
6. Do not speculate about data that is absent. If something is null or unavailable, say it is unavailable.

STYLE: direct and concrete, addressed to the pilot as "you". No preamble, no bullet points, no headings. Plain prose, 3 to 5 sentences.`;

function buildMessages(context, question) {
  const user = question
    ? `Question from the crew member: ${question}\n\nStructured data:\n${JSON.stringify(context, null, 2)}`
    : `Structured data:\n${JSON.stringify(context, null, 2)}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function hasKey() {
  return Boolean(process.env.GROQ_API_KEY);
}

async function generate(context, question, options = {}) {
  if (!hasKey()) {
    const err = new Error('GROQ_API_KEY is not set');
    err.code = 'NO_KEY';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: options.model || MODEL,
        temperature: 0.2,
        max_tokens: 400,
        messages: buildMessages(context, question),
      }),
    });
    if (!res.ok) throw new Error(`Groq returned ${res.status}`);
    const body = await res.json();
    const text = body.choices && body.choices[0] && body.choices[0].message.content;
    if (!text) throw new Error('Groq returned no content');
    return { text: text.trim(), model: options.model || MODEL };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generate, hasKey, buildMessages, SYSTEM_PROMPT, MODEL };
