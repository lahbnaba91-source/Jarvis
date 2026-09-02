'use strict';

// Dose limits as configurable policy objects, never hardcoded constants (brief §5).
//
// Values were read from the primary sources at implementation time, not copied from
// the brief's illustrative example. Every policy carries its citation and the exact
// wording it came from, plus verifyBeforeUse — an advisory tool quoting a stale
// limit is worse than one quoting none.
//
// Note the policies genuinely differ. ICRP-103 and the FAA phrase the limit as a
// 5-year average of 20 mSv/yr with a 50 mSv single-year ceiling. The EU BSS makes
// 20 mSv the limit in any single year, with the 5-year averaging route available
// only as a special-circumstances authorisation. Picking a policy changes the answer.

const POLICIES = {
  'faa-ac120-61b': {
    policyId: 'faa-ac120-61b',
    label: 'FAA AC 120-61B (US aircrew guidance)',
    annualLimitMSv: 20,
    averagingWindowYears: 5,
    singleYearCeilingMSv: 50,
    pregnancy: {
      monthlyMaxMSv: 0.5,
      totalMSv: null, // the AC sets a monthly rate only; the 1 mSv term total is ICRP/NCRP
      basis: 'declared pregnancy; FAA states a monthly rate, not a term total',
    },
    source: 'FAA Advisory Circular 120-61B, "In-Flight Radiation Exposure", dated 11/21/14',
    quotes: {
      occupational:
        'The recommended occupational exposure limit for ionizing radiation is a 5-year ' +
        'average effective dose of 20 mSv per year, with no more than 50 mSv in a single year. (para 7b)',
      pregnancy:
        'the FAA recommends she limit ionizing radiation exposure of her conceptus to no ' +
        'more than 0.5 mSv per month. (para 7c)',
    },
    caveat:
      'AC 120-61B is guidance, not a regulation, and dates from 2014 — before the 2026 ' +
      'NASEM finding that protections for flight crew are insufficient.',
    verifyBeforeUse: true,
  },

  'icrp-103-occupational': {
    policyId: 'icrp-103-occupational',
    label: 'ICRP-103 occupational',
    annualLimitMSv: 20,
    averagingWindowYears: 5,
    fiveYearTotalMSv: 100,
    singleYearCeilingMSv: 50,
    pregnancy: {
      monthlyMaxMSv: 0.5,
      totalMSv: 1,
      basis: 'declared pregnancy, remainder of term, dose to the conceptus',
    },
    source: 'ICRP Publication 103 (2007), occupational dose limits',
    caveat:
      'ICRP-103 is a paid standard that has not been read directly here; these values come ' +
      'from published summaries and agree with FAA AC 120-61B. Verify against the standard ' +
      'before relying on them.',
    verifyBeforeUse: true,
  },

  'eu-bss-2013-59': {
    policyId: 'eu-bss-2013-59',
    label: 'EU Basic Safety Standards (Directive 2013/59/Euratom)',
    annualLimitMSv: 20,
    averagingWindowYears: 5,
    singleYearCeilingMSv: 50,
    singleYearCeilingRequiresAuthorisation: true,
    aircrewAssessmentThresholdMSv: 1, // above this, crew are treated as occupationally exposed
    pregnancy: {
      monthlyMaxMSv: null,
      totalMSv: 1,
      basis: 'dose to the unborn child for the remainder of the pregnancy',
    },
    source: 'Council Directive 2013/59/Euratom, Chapter III',
    quotes: {
      occupational:
        'The limit on the effective dose for occupational exposure shall be 20 mSv in any ' +
        'single year. In special circumstances ... a higher effective dose of up to 50 mSv ' +
        'may be authorised ... provided that the average annual dose over any five consecutive ' +
        'years does not exceed 20 mSv.',
    },
    caveat:
      'The EU treats aircrew cosmic exposure as occupational and requires assessment above ' +
      '1 mSv/yr — a legal duty that has no US equivalent.',
    verifyBeforeUse: true,
  },
};

const DEFAULT_POLICY_ID = 'faa-ac120-61b';

function getPolicy(policyId = DEFAULT_POLICY_ID) {
  const policy = POLICIES[policyId];
  if (!policy) {
    throw new Error(`Unknown policy "${policyId}" (have: ${Object.keys(POLICIES).join(', ')})`);
  }
  return policy;
}

function listPolicies() {
  return Object.values(POLICIES).map((p) => ({
    policyId: p.policyId,
    label: p.label,
    annualLimitMSv: p.annualLimitMSv,
    source: p.source,
  }));
}

module.exports = { POLICIES, DEFAULT_POLICY_ID, getPolicy, listPolicies };
