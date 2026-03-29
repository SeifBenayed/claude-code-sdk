#!/bin/bash
# run.sh — Master orchestrator for the 3-agent benchmark pipeline
#
# Usage:
#   ./run.sh                      # Full pipeline (generate → groundtruth → cloclo → judge)
#   ./run.sh generate             # Only generate questions
#   ./run.sh groundtruth          # Only run reference ground truth
#   ./run.sh cloclo               # Only run cloclo answers
#   ./run.sh judge                # Only run the judge
#   ./run.sh judge --judge-model gpt-5.4  # Use specific judge model
#
# Current defaults:
#   Agent 1 (generate questions): gpt-5.4
#   Agent 2 (ground truth):       gpt-5.4
#   Agent 3 (judge):              gpt-5.4

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

GEN_MODEL="${GEN_MODEL:-gpt-5.4}"
GROUNDTRUTH_MODEL="${GROUNDTRUTH_MODEL:-gpt-5.4}"
CANDIDATE_MODEL="${CANDIDATE_MODEL:-gpt-5.4}"
JUDGE_MODEL="${JUDGE_MODEL:-gpt-5.4}"

echo "╔═══════════════════════════════════════════════════╗"
echo "║  AUTORESEARCH: 3-AGENT BENCHMARK PIPELINE         ║"
echo "║                                                   ║"
echo "║  Agent 1 (Questions):    ${GEN_MODEL}                  ║"
echo "║  Agent 2 (Ground Truth): ${GROUNDTRUTH_MODEL}                  ║"
echo "║  Agent 2B (Candidate):   ${CANDIDATE_MODEL}                  ║"
echo "║  Agent 3 (Judge):        ${JUDGE_MODEL}                  ║"
echo "║                                                   ║"
echo "║  GPT-5.4-only fallback mode                       ║"
echo "╚═══════════════════════════════════════════════════╝"
echo ""

MODE="${1:-all}"

run_generate() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  STEP 1/4: Generating 1000 benchmark questions"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  BENCHMARK_MODEL="$GEN_MODEL" node "$DIR/agent1-generate.mjs"
  echo ""
}

run_groundtruth() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  STEP 2/4: Reference model generates ground truth"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node "$DIR/agent2-groundtruth.mjs" groundtruth --model="$GROUNDTRUTH_MODEL"
  echo ""
}

run_cloclo() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  STEP 3/4: Cloclo answers the same questions"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node "$DIR/agent2-groundtruth.mjs" cloclo --model="$CANDIDATE_MODEL"
  echo ""
}

run_judge() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  STEP 4/4: Judge compares (model: $JUDGE_MODEL)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  node "$DIR/agent3-judge.mjs" --judge-model="$JUDGE_MODEL"
  echo ""
}

case "$MODE" in
  all)
    run_generate
    run_groundtruth
    run_cloclo
    run_judge
    ;;
  generate|gen)   run_generate ;;
  groundtruth|gt) run_groundtruth ;;
  cloclo)         run_cloclo ;;
  judge)          shift; JUDGE_MODEL="${2:-$JUDGE_MODEL}"; run_judge ;;
  *)
    echo "Usage: ./run.sh [all|generate|groundtruth|cloclo|judge]"
    exit 1
    ;;
esac

echo "╔═══════════════════════════════════════════════════╗"
echo "║  PIPELINE COMPLETE                                ║"
echo "║  Results: $DIR/scores.json       ║"
echo "╚═══════════════════════════════════════════════════╝"
