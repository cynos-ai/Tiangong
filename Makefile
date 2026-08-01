SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

AGENTTEAMS := ./scripts/agentteams.sh
WORKER_IMAGE_BUILD := ./scripts/build-worker-image.sh
WORKER_IMAGE_TEST := ./smoke-testing/support/run-worker-smoke.sh
REVIEWER_IMAGE_TEST := ./smoke-testing/support/run-reviewer-smoke.sh
PEER_MENTION_SMOKE := ./smoke-testing/support/run-peer-mention-smoke.sh
PEER_MENTION_SMOKE_TEST := ./scripts/test-peer-mention-smoke.sh
SKILL_CHECK := node ./scripts/check-skills.mjs
REVIEWER_SMOKE_CONTRACT := node ./scripts/test-reviewer-smoke-oracle.mjs

.PHONY: help init up start stop down status verify config logs login uninstall check-skills build-worker-image test-worker-image-basic test-worker-image test-reviewer-smoke-contract test-reviewer-image-basic test-reviewer-image-git test-reviewer-image test-reviewer-journey-canary test-peer-mention-smoke-contract test-peer-mention-smoke

help: ## Show available commands
	@printf '%s\n' 'Tiangong local development commands:'
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  make %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

init: ## Create a private .env from .env.example
	@$(AGENTTEAMS) init

up: ## Install or upgrade the pinned AgentTeams stack
	@$(AGENTTEAMS) up

start: ## Start existing AgentTeams containers
	@$(AGENTTEAMS) start

stop: ## Stop AgentTeams while preserving data
	@$(AGENTTEAMS) stop

down: stop ## Alias for stop

status: ## Show AgentTeams containers and endpoints
	@$(AGENTTEAMS) status

verify: ## Run local AgentTeams readiness checks
	@$(AGENTTEAMS) verify

config: ## Show effective configuration with secrets redacted
	@$(AGENTTEAMS) config

logs: ## Follow logs; use SERVICE=controller for controller logs
	@$(AGENTTEAMS) logs $(SERVICE)

login: ## Show Element URL and local credential location
	@$(AGENTTEAMS) login

check-skills: ## Validate project Agent Skills and trigger cases
	@$(SKILL_CHECK)

build-worker-image: ## Build the pinned local Tiangong Worker image
	@$(WORKER_IMAGE_BUILD)

test-worker-image-basic: ## Run the fast Matrix-to-pi Worker smoke and clean up
	@TIANGONG_WORKER_SMOKE_LEVEL=basic $(WORKER_IMAGE_TEST)

test-worker-image: ## Run the full Gate/approval/recovery Worker smoke and clean up
	@TIANGONG_WORKER_SMOKE_LEVEL=full $(WORKER_IMAGE_TEST)

test-reviewer-smoke-contract: ## Validate Reviewer smoke oracle phase semantics
	@$(REVIEWER_SMOKE_CONTRACT)

test-reviewer-image-basic: ## Run the Reviewer Matrix Basic smoke and clean up
	@TIANGONG_REVIEWER_SMOKE_LEVEL=basic $(REVIEWER_IMAGE_TEST)

test-reviewer-image-git: ## Run the Reviewer local-Git Matrix Basic smoke and clean up
	@TIANGONG_REVIEWER_SMOKE_LEVEL=git $(REVIEWER_IMAGE_TEST)

test-reviewer-image: ## Run the hard-gate Reviewer recovery Full smoke and clean up
	@TIANGONG_REVIEWER_SMOKE_LEVEL=recovery $(REVIEWER_IMAGE_TEST)

test-reviewer-journey-canary: ## Observe non-gating post-restart model progression and clean up
	@TIANGONG_REVIEWER_SMOKE_LEVEL=journey $(REVIEWER_IMAGE_TEST)

test-peer-mention-smoke-contract: ## Validate the Worker peer mention fixture and event oracle
	@$(PEER_MENTION_SMOKE_TEST)

test-peer-mention-smoke: ## Run the focused Worker peer mention smoke and clean up
	@$(PEER_MENTION_SMOKE)

uninstall: ## Delete local AgentTeams data; requires CONFIRM=delete-tiangong-agentteams-data
	@CONFIRM="$(CONFIRM)" $(AGENTTEAMS) uninstall
