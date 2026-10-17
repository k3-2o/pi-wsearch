export PATH := "node_modules/.bin:" + env_var_or_default("PATH", "")

default: check

prepare:
	bun install --frozen-lockfile

check: prepare lint format-check typecheck knip test

check-lite: check

lint:
	oxlint

format:
	oxfmt

format-check:
	oxfmt --check

typecheck:
	tsc --noEmit

knip:
	bun scripts/knip.mjs

test:
	bun test --jobs 1 test/

coverage:
	bun test --jobs 1 test/ --coverage

install:
	pi install {{justfile_directory()}}