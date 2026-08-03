SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

AGENTTEAMS := ./scripts/agentteams.sh
WORKER_IMAGE_BUILD := ./scripts/build-worker-image.sh
WORKER_IMAGE_TEST := ./smoke-testing/support/run-worker-smoke.sh
LEADER_SMOKE := ./smoke-testing/support/run-leader-smoke.sh
LEADER_SMOKE_TEST := ./scripts/test-leader-smoke.sh
REVIEWER_IMAGE_TEST := ./smoke-testing/support/run-reviewer-smoke.sh
PEER_MENTION_SMOKE := ./smoke-testing/support/run-peer-mention-smoke.sh
PEER_MENTION_SMOKE_TEST := ./scripts/test-peer-mention-smoke.sh
RUNNER_ISOLATION_SPIKE := ./smoke-testing/support/run-runner-isolation-spike.sh
RUNNER_EXECUTOR_SMOKE := node ./smoke-testing/support/run-runner-executor-smoke.mjs
RUNNER_BROKER_SMOKE := node ./smoke-testing/support/run-runner-broker-smoke.mjs
RUNNER_BROKER := ./scripts/runner-broker.sh
RUNNER_PREPARATION_SMOKE := ./smoke-testing/support/run-runner-preparation-smoke.sh
DEPLOYMENT_SERVICE_SMOKE := node ./smoke-testing/support/run-deployment-service-smoke.mjs
SKILL_CHECK := node ./scripts/check-skills.mjs
REVIEWER_SMOKE_CONTRACT := node ./scripts/test-reviewer-smoke-oracle.mjs
PAUSE_WORKER_BOUNDARY_TEST := ./scripts/test-pause-worker-boundary.sh

.PHONY: help init up start stop down status verify config logs login uninstall check-skills build-worker-image test-worker-image-basic test-worker-image test-leader-smoke-contract test-leader-image-basic test-runner-isolation test-runner-executor test-runner-broker test-runner-preparation start-runner-broker status-runner-broker stop-runner-broker test-deployment-service test-reviewer-smoke-contract test-reviewer-image-basic test-reviewer-image-git test-reviewer-image test-reviewer-journey-canary test-peer-mention-smoke-contract test-peer-mention-smoke test-pause-worker-boundary

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

test-leader-smoke-contract: ## Validate Leader smoke requester-report and in-container oracle semantics
	@$(LEADER_SMOKE_TEST)

test-leader-image-basic: ## Run the Leader Matrix coordination (blocked terminal partial) smoke and clean up
	@$(LEADER_SMOKE)

test-runner-isolation: ## Prove the disposable RunnerPort isolation contract and clean up
	@$(RUNNER_ISOLATION_SPIKE)

test-runner-executor: ## Run the production Docker executor against the isolation fixture
	@$(RUNNER_EXECUTOR_SMOKE)

test-runner-broker: ## Prove the closed container-identity Runner broker path
	@$(RUNNER_BROKER_SMOKE)

test-runner-preparation: ## Prove broker registration precedes fixed Worker plan access
	@$(RUNNER_PREPARATION_SMOKE)

start-runner-broker: ## Start the fixed shared Runner broker and preparation boundary
	@$(RUNNER_BROKER) start

status-runner-broker: ## Verify the fixed shared Runner broker boundary
	@$(RUNNER_BROKER) status

stop-runner-broker: ## Stop the shared Runner broker; use PURGE=1 to remove its state
	@$(RUNNER_BROKER) stop $(if $(PURGE),--purge,)

test-deployment-service: ## Prove the disposable deployment target state and authorization contract
	@$(DEPLOYMENT_SERVICE_SMOKE)

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

test-pause-worker-boundary: ## Test the bounded paused-Worker smoke orchestration guard
	@$(PAUSE_WORKER_BOUNDARY_TEST)

uninstall: ## Delete local AgentTeams data; requires CONFIRM=delete-tiangong-agentteams-data
	@CONFIRM="$(CONFIRM)" $(AGENTTEAMS) uninstall
