'use strict';

// Brief orchestrator.
//
// Deterministic text is the baseline and always exists. The LLM is allowed to
// replace it only if a key is configured, the call succeeds, AND every numeral in
// its output traces back to the structured input. Any failure at any step falls
// back silently in capability but loudly in provenance — the response always says
// which path produced the words.

const { buildContext } = require('./context');
const { render } = require('./render');
const { validate } = require('./guard');
const prompt = require('./prompt');

const DISCLAIMER =
  'Modeled estimate against published reference limits, not a dosimeter reading and not ' +
  'medical advice — discuss health implications with your AME.';

async function brief(options = {}) {
  const context = buildContext(options);
  const deterministic = render(context);

  const result = {
    text: deterministic,
    source: 'deterministic',
    model: null,
    guard: null,
    disclaimer: DISCLAIMER,
    sourceData: context,
  };

  if (options.deterministicOnly || !prompt.hasKey()) {
    result.note = prompt.hasKey()
      ? 'Deterministic renderer requested.'
      : 'No GROQ_API_KEY configured, so the deterministic renderer produced this.';
    return result;
  }

  try {
    const generated = await prompt.generate(context, options.question, options);
    const guard = validate(generated.text, context);
    result.guard = guard;

    if (!guard.ok) {
      // A figure the data cannot account for means the whole generation is discarded.
      result.note =
        `LLM output rejected: ${guard.unsupported.length} numeral(s) not present in the ` +
        `source data (${guard.unsupported.join(', ')}). Showing the deterministic brief instead.`;
      result.rejectedText = generated.text;
      return result;
    }

    result.text = generated.text;
    result.source = 'llm';
    result.model = generated.model;
    result.note = `Every numeral verified against the source data (${guard.checked} checked).`;
    return result;
  } catch (err) {
    result.note = `LLM unavailable (${err.message}); showing the deterministic brief.`;
    return result;
  }
}

module.exports = { brief, DISCLAIMER };
