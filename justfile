export PATH := "node_modules/.bin:" + env_var_or_default("PATH", "")

# Default gate for Linux and CI.
default: check

# Full gate: lint, format, typecheck, knip, tests.
check: lint format-check typecheck knip test

# Partial gate: everything that runs on this machine (knip crashes on Termux/Android).
check-lite: lint format-check typecheck test

# Lint with oxlint.
lint:
	oxlint

# Format source files in place.
format:
	oxfmt

# Verify formatting, no writes.
format-check:
	oxfmt --check

# Typecheck with tsc.
typecheck:
	tsc --noEmit

# Report unused files and exports.
knip:
	knip

# Run the test suite serially; parallel runs flake on live-network tests.
test:
	bun test --jobs 1 test/

# Coverage report.
coverage:
	bun test --jobs 1 test/ --coverage

# Register this repo as the installed pi extension.
install:
	pi install {{justfile_directory()}}