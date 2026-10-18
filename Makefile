# Plugin distribution is separate from npm's server release pipeline.
PYTHON ?= python3
.PHONY: check-plugin stage-plugin pack-plugin smoke-plugin

check-plugin:
	$(PYTHON) scripts/package-plugin.py check

stage-plugin: check-plugin
	$(PYTHON) scripts/package-plugin.py stage

pack-plugin: check-plugin
	$(PYTHON) scripts/package-plugin.py pack

# Tests the staged npm command with legacy and modern clients on temporary proofs.
smoke-plugin: pack-plugin
	$(PYTHON) scripts/smoke-plugin.py .plugin-build/agda-mcp-plugin-$(shell $(PYTHON) -c 'import json; print(json.load(open("plugin.json"))["version"])').zip
	$(PYTHON) scripts/smoke-plugin.py .plugin-build/agda-mcp-plugin-$(shell $(PYTHON) -c 'import json; print(json.load(open("plugin.json"))["version"])').zip --modern
