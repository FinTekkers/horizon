"""Agent providers (HZ-83): one module per backend, each exporting the same
shape — run(), assert_subscription_auth(), SUPPORTS_RESUME — so
farm/agent_runner.py can dispatch without knowing which one it's driving.
"""
