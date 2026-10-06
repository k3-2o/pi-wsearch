export PATH := "node_modules/.bin:" + env_var_or_default("PATH", "")

default: check

check: lint format-check typecheck knip test

lint:
	oxlint

format:
	oxfmt

format-check:
	oxfmt --check

typecheck:
	tsc --noEmit

knip:
	knip

coverage:
	bun test --jobs 1 test/ --coverage

test:
	bun test --jobs 1 test/

install:
	mkdir -p $HOME/.pi/agent/extensions/pi-wsearch/src
	cp index.ts $HOME/.pi/agent/extensions/pi-wsearch/
	cp src/*.ts $HOME/.pi/agent/extensions/pi-wsearch/src/
