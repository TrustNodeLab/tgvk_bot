"""Offline contract tests for the long-video profile registry.

The module under test is pure Python and has no network, TTS, or render
dependencies.  The direct-execution entry point keeps the test usable in the
repository's dependency-light CI environment.
"""
from __future__ import annotations

import json
import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The long-video runtime historically imports sibling modules as top-level
# modules.  Use the same mode here so the profile registry is not duplicated
# as ``long_profiles`` and ``bot.long_profiles`` in a combined test process.
sys.path.insert(0, os.path.join(ROOT, "bot"))

from long_profiles import (  # noqa: E402
    MAX_SOURCE_CONTEXT,
    UnknownProfileError,
    blueprint,
    get_profile,
    list_profiles,
    profile_metadata,
    script_rules,
    shot_policy,
    validate_blueprint,
    validate_profile,
    validate_shares,
)


class LongProfilesContractTests(unittest.TestCase):
    def test_registry_is_sorted_and_get_profile_isolated(self):
        self.assertEqual(list_profiles(), ["classic", "trustnode_casebook"])

        first, key = get_profile("trustnode_casebook")
        self.assertEqual(key, "trustnode_casebook")
        first["required_roles"].append("mutable-test")
        first["shot_policy"]["max_interstitials"] = 99

        second, second_key = get_profile("TRUSTNODE_CASEBOOK")
        self.assertEqual(second_key, key)
        self.assertNotIn("mutable-test", second["required_roles"])
        self.assertEqual(second["shot_policy"]["max_interstitials"], 0)

    def test_registered_profile_contracts_declare_a_valid_arc(self):
        self.assertEqual(validate_profile("classic"), "classic")
        self.assertEqual(validate_profile("trustnode_casebook"), "trustnode_casebook")

    def test_empty_profile_uses_compatibility_default_but_unknown_is_explicit(self):
        profile, key = get_profile("")
        self.assertEqual(key, "classic")
        self.assertEqual(profile["key"], "classic")
        with self.assertRaises(UnknownProfileError):
            get_profile("not-a-profile")

    def test_classic_blueprint_preserves_legacy_roles_and_normalized_shares(self):
        plan = blueprint("classic", 6, "doc")
        self.assertEqual(
            [item["role"] for item in plan],
            ["hook", "chapter", "chapter", "chapter", "chapter", "chapter", "chapter", "finale"],
        )
        self.assertEqual([item["format"] for item in plan], ["doc"] * len(plan))
        self.assertEqual(validate_shares(plan), tuple(item["share"] for item in plan))
        self.assertAlmostEqual(math.fsum(item["share"] for item in plan), 1.0)
        self.assertTrue(all(math.isfinite(item["share"]) and item["share"] >= 0
                            for item in plan))

    def test_casebook_blueprint_has_required_arc_for_every_format(self):
        required = {"cold_open", "evidence", "mechanism", "action", "counterpoint", "close"}
        for fmt in ("doc", "breakdown", "top10"):
            with self.subTest(format=fmt):
                plan = blueprint("trustnode_casebook", 6, fmt)
                roles = {item["profile_role"] for item in plan}
                self.assertTrue(required.issubset(roles), (fmt, roles))
                self.assertLessEqual(
                    sum(item["profile_role"] == "counterpoint" for item in plan), 1
                )
                self.assertTrue(all("visual_mode" in item for item in plan))
                self.assertTrue(all("protected" in item for item in plan))
                self.assertTrue(all("anchor" in item for item in plan))
                self.assertAlmostEqual(math.fsum(item["share"] for item in plan), 1.0)
                validate_blueprint(plan)

    def test_blueprint_is_deterministic_and_format_remains_orthogonal(self):
        first = blueprint("trustnode_casebook", 8, "breakdown")
        second = blueprint("trustnode_casebook", 8, "breakdown")
        self.assertEqual(first, second)
        doc = blueprint("trustnode_casebook", 8, "doc")
        self.assertNotEqual([item["role"] for item in first],
                            [item["role"] for item in doc])
        self.assertEqual({item["profile"] for item in first}, {"trustnode_casebook"})

    def test_script_rules_are_bounded_and_grounded_in_source(self):
        sentinel = "SENTINEL-SOURCE-FACT-42"
        source = sentinel + (" additional context " * 2000)
        rules = script_rules(
            "trustnode_casebook", "mechanism", index=1, total=3,
            source_context=source,
        )
        self.assertIn(sentinel, rules)
        self.assertLessEqual(len(rules), MAX_SOURCE_CONTEXT + 1800)
        self.assertIn("mechanism", rules)
        self.assertIn("profile_role", rules)
        for forbidden in ("named creator", "catchphrase", "signature cadence"):
            self.assertNotIn(forbidden, rules.lower())

    def test_casebook_shot_policy_is_documentary_and_disables_interstitials(self):
        policy = shot_policy("trustnode_casebook")
        self.assertEqual(policy["style"], "documentary")
        self.assertFalse(policy["allow_interstitial"])
        self.assertEqual(policy["max_interstitials"], 0)
        self.assertEqual(policy["max_counterpoint"], 1)
        self.assertIn("close", policy["protected_roles"])

    def test_metadata_is_small_serializable_contract(self):
        metadata = profile_metadata("trustnode_casebook")
        encoded = json.dumps(metadata, ensure_ascii=False)
        self.assertIn("trustnode_casebook", encoded)
        self.assertEqual(metadata["profile"], "trustnode_casebook")
        self.assertEqual(metadata["style"], "documentary")
        self.assertNotIn("callable", metadata)

    def test_invalid_share_contract_fails(self):
        with self.assertRaises(ValueError):
            validate_shares([-0.1, 1.1])
        with self.assertRaises(ValueError):
            validate_shares([float("nan"), 1.0])
        with self.assertRaises(ValueError):
            validate_shares([0.2, 0.2])


if __name__ == "__main__":
    unittest.main(verbosity=2)
