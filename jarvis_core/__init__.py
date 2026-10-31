"""Shared, dependency-free building blocks for Jarvis's tool integrations.

evidence      -- Observation / Scope / ActionStatus model, freshness and
                 claim-support rules (the core of status verification)
github_verify -- read-only, allowlisted GitHub lookups that return Observations
vault_status  -- scoped observations of the local HQ copy and its sync metadata
claims        -- turn ledger + reply guard that flags unsupported status claims
agent_tools   -- exposes the read-only checks to a Claude Agent SDK session
"""
