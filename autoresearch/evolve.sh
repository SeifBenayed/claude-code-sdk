#!/bin/bash
# evolve.sh — Autoresearch RL loop for cloclo self-improvement
#
# Usage: ./evolve.sh [hours] [model]
# Example: ./evolve.sh 8 gpt-5.4
#
# Flow per generation:
#   1. Restore the current best code
#   2. Mutate the best code once
#   3. npm run build → rebuild cloclo
#   4. Cloclo answers 1000 questions
#   5. Score against ground truth
#   6. Keep the mutation only if it beats the best
#   7. Repeat

set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$HOME/claude-tool-loop"
SRC_DIR="$PROJECT/src"
BENCH_FILE="$DIR/benchmark-1000.json"
GT_FILE="$DIR/ground-truth.json"
GEN_DIR="$DIR/generations"
RESULTS_DIR="$DIR/results"
SCOREBOARD="$DIR/scoreboard.json"

# Config
HOURS="${1:-8}"
MODEL="${2:-gpt-5.4}"
MUTATOR_MODEL="${MUTATOR_MODEL:-gpt-5.4}"
BENCH_CONCURRENCY="${BENCH_CONCURRENCY:-4}"
BENCH_TIMEOUT_MS="${BENCH_TIMEOUT_MS:-600000}"
BENCH_LOG_EVERY="${BENCH_LOG_EVERY:-10}"
BENCH_CHECKPOINT_EVERY="${BENCH_CHECKPOINT_EVERY:-1}"
BENCH_RETRIES="${BENCH_RETRIES:-2}"
END_TIME=$(($(date +%s) + HOURS * 3600))

mkdir -p "$GEN_DIR" "$RESULTS_DIR"

# Initialize scoreboard
if [ ! -f "$SCOREBOARD" ]; then
  echo '{"generations":[],"best_score":0,"best_gen":"none"}' > "$SCOREBOARD"
fi

BEST_SCORE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCOREBOARD','utf-8')).best_score)")

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  AUTORESEARCH: CLOCLO EVOLUTION ENGINE                ║"
echo "║                                                       ║"
echo "║  Candidate:    cloclo --model $MODEL                  ║"
echo "║  Ground truth: ground-truth.json (existing)           ║"
echo "║  Mutator:      cloclo --model $MUTATOR_MODEL          ║"
echo "║  Benchmark:    concurrency=$BENCH_CONCURRENCY timeout=${BENCH_TIMEOUT_MS}ms ║"
echo "║  Duration:     ${HOURS}h                              ║"
echo "║  Best score:   ${BEST_SCORE}%                         ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

LAST_GEN_NUM=$(find "$GEN_DIR" -maxdepth 1 -type d -name 'gen_*' -exec basename {} \; 2>/dev/null | sed -E 's/^gen_0*//' | awk 'NF { print $1 + 0 }' | sort -n | tail -1)
GEN="${LAST_GEN_NUM:-0}"

while [ "$(date +%s)" -lt "$END_TIME" ]; do
  RESUMING=0
  CURRENT_MAX_LABEL="gen_$(printf '%03d' "$GEN")"
  if [ "$GEN" -gt 0 ] && [ -d "$GEN_DIR/$CURRENT_MAX_LABEL" ] && [ ! -f "$RESULTS_DIR/${CURRENT_MAX_LABEL}_scores.json" ] && [ -d "$GEN_DIR/$CURRENT_MAX_LABEL/src_after" ]; then
    GEN_LABEL="$CURRENT_MAX_LABEL"
    RESUMING=1
    echo "  ↺ Resuming incomplete generation $GEN_LABEL"
  else
    if [ "$GEN" -gt 0 ] && [ -d "$GEN_DIR/$CURRENT_MAX_LABEL" ] && [ ! -f "$RESULTS_DIR/${CURRENT_MAX_LABEL}_scores.json" ]; then
      echo "  ↷ Skipping incompatible incomplete generation $CURRENT_MAX_LABEL"
      echo "    It does not have a benchmarkable candidate snapshot, so a fresh generation will be created."
    fi
    GEN=$((GEN + 1))
    GEN_LABEL="gen_$(printf '%03d' "$GEN")"
  fi
  GEN_SNAPSHOT="$GEN_DIR/$GEN_LABEL"
  REMAINING=$(( (END_TIME - $(date +%s)) / 60 ))

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  GENERATION $GEN [$GEN_LABEL] — ${REMAINING}min remaining"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  mkdir -p "$GEN_SNAPSHOT"

  if [ "$RESUMING" = "1" ]; then
    cp "$GEN_SNAPSHOT/src_after/"*.mjs "$SRC_DIR/"
    cd "$PROJECT" && npm run build 2>/dev/null || true
    DIFF_LINES=$(wc -l < "$GEN_SNAPSHOT/mutation.diff" 2>/dev/null || echo 0)
    TEE_ARGS=(-a)
    echo "  → Restored candidate snapshot from $GEN_LABEL"
  else
    BEST_GEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCOREBOARD','utf-8')).best_gen || 'none')")
    if [ "$BEST_GEN" != "none" ] && [ -d "$GEN_DIR/$BEST_GEN/src_after" ]; then
      cp "$GEN_DIR/$BEST_GEN/src_after/"*.mjs "$SRC_DIR/"
      cd "$PROJECT" && npm run build 2>/dev/null
      echo "  → Restored best baseline from $BEST_GEN"
    fi

    mkdir -p "$GEN_SNAPSHOT/src_before"
    rm -f "$GEN_SNAPSHOT/src_before/"*.mjs 2>/dev/null || true
    cp "$SRC_DIR"/*.mjs "$GEN_SNAPSHOT/src_before/"

    FEEDBACK_LABEL="$BEST_GEN"
    FEEDBACK_SCORES_FILE="$RESULTS_DIR/${FEEDBACK_LABEL}_scores.json"
    if [ "$FEEDBACK_LABEL" != "none" ] && [ -f "$FEEDBACK_SCORES_FILE" ]; then
      FEEDBACK_WEAK_CAT=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$FEEDBACK_SCORES_FILE','utf-8'));
        const sorted = Object.entries(s.catScores).sort((a,b) => a[1].sum/a[1].count - b[1].sum/b[1].count);
        console.log(sorted[0]?.[0] || 'unknown');
      ")
      FEEDBACK_WEAK_CATS=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$FEEDBACK_SCORES_FILE','utf-8'));
        const sorted = Object.entries(s.catScores).sort((a,b) => a[1].sum/a[1].count - b[1].sum/b[1].count);
        console.log(sorted.slice(0,3).map(([c,d]) => c + ' (' + (d.sum/d.count*100).toFixed(1) + '%)').join(', '));
      ")
      FEEDBACK_READ_INSTRUCTIONS="Read ~/claude-tool-loop/autoresearch/results/${FEEDBACK_LABEL}_scores.json for detailed scores."

      FAILURE_CONTEXT=$(FEEDBACK_LABEL="$FEEDBACK_LABEL" FEEDBACK_SCORES_FILE="$FEEDBACK_SCORES_FILE" BENCH_FILE="$BENCH_FILE" RESULTS_DIR="$RESULTS_DIR" node <<'NODE'
const fs = require("fs");
const path = require("path");

const { FEEDBACK_LABEL, FEEDBACK_SCORES_FILE, BENCH_FILE, RESULTS_DIR } = process.env;
const scores = JSON.parse(fs.readFileSync(FEEDBACK_SCORES_FILE, "utf-8"));
const bench = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));
const answersPath = path.join(RESULTS_DIR, `${FEEDBACK_LABEL}_cloclo.json`);
const candidate = fs.existsSync(answersPath)
  ? JSON.parse(fs.readFileSync(answersPath, "utf-8"))
  : { answers: {} };

const clean = (value, limit) => String(value || "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

const sortedCats = Object.entries(scores.catScores)
  .sort((a, b) => a[1].sum / a[1].count - b[1].sum / b[1].count)
  .slice(0, 3)
  .map(([cat]) => cat);

const lines = [];
for (const [index, cat] of sortedCats.entries()) {
  const ranked = bench.tasks
    .filter((task) => task.category === cat)
    .map((task) => {
      const ans = candidate.answers?.[task.id] || {};
      const answer = typeof ans.answer === "string" ? ans.answer : "";
      const runtime = typeof ans.errorMessage === "string" ? ans.errorMessage : "";
      const blocked = /(isn't in|couldn't find|give me its path|attach it|not present under|couldn’t find|give me the file)/i.test(answer);
      const score = (ans.error ? 100 : 0) + (!answer.trim() ? 50 : 0) + (blocked ? 20 : 0) + Math.max(0, 200 - answer.length);
      return { task, ans, score, answer, runtime };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, index === 0 ? 2 : 1);

  lines.push(`Category ${cat}:`);
  for (const item of ranked) {
    lines.push(`- Q${item.task.id}: ${clean(item.task.task, 220)}`);
    lines.push(`  Candidate: ${clean(item.answer || "<empty>", 220)}`);
    if (item.runtime) lines.push(`  Runtime: ${clean(item.runtime, 160)}`);
  }
}

process.stdout.write(lines.join("\n"));
NODE
      )
    else
      FEEDBACK_WEAK_CAT="unknown"
      FEEDBACK_WEAK_CATS="unknown"
      FEEDBACK_READ_INSTRUCTIONS="No prior scored generation is available yet; inspect the current code directly."
      FAILURE_CONTEXT="No prior scored generation is available yet."
    fi

    echo "  → cloclo ($MUTATOR_MODEL) is mutating from the current best..."
    if ! (
      cd "$PROJECT" && \
      node "$PROJECT/claude-native.mjs" --yes --model "$MUTATOR_MODEL" -p "You are optimizing cloclo CLI to score better on benchmarks.

Current best generation: ${BEST_GEN}.
Current best score: ${BEST_SCORE}%.
Weakest categories in the current best: $FEEDBACK_WEAK_CATS

Read ~/claude-tool-loop/autoresearch/program.md for full directives.
$FEEDBACK_READ_INSTRUCTIONS

Concrete failure examples from the current best run:
$FAILURE_CONTEXT

Then:
1. Read the relevant src/ file(s) for the weakest category
2. Make ONE targeted improvement to the current best code
3. Run: cd ~/claude-tool-loop && npm run build
4. Run: cd ~/claude-tool-loop && npm test (verify nothing broke)

Focus on '$FEEDBACK_WEAK_CAT'. Small, surgical change only.
The goal is to beat the current best score.
If the failures point to infrastructure (permissions, retries, output handling, path assumptions), fix that root cause instead of making a cosmetic prompt tweak."
    ) 2>&1 | tee "$GEN_SNAPSHOT/mutation.log"; then
      echo "  ⚠ Mutation step exited non-zero. Continuing with the current src/ state."
    fi

    mkdir -p "$GEN_SNAPSHOT/src_after"
    rm -f "$GEN_SNAPSHOT/src_after/"*.mjs 2>/dev/null || true
    cp "$SRC_DIR"/*.mjs "$GEN_SNAPSHOT/src_after/"

    diff -ru "$GEN_SNAPSHOT/src_before" "$GEN_SNAPSHOT/src_after" > "$GEN_SNAPSHOT/mutation.diff" 2>/dev/null || true
    DIFF_LINES=$(wc -l < "$GEN_SNAPSHOT/mutation.diff" 2>/dev/null || echo 0)
    echo "  → Mutation diff: $DIFF_LINES lines changed"

    echo "  → Rebuilding cloclo..."
    cd "$PROJECT" && npm run build 2>/dev/null
    echo "  → Build complete"
    TEE_ARGS=()
  fi

  echo "  → Running cloclo ($MODEL) on 1000 questions..."
  if ! node "$DIR/run-cloclo-parallel.mjs" \
    --model="$MODEL" \
    --concurrency="$BENCH_CONCURRENCY" \
    --timeout-ms="$BENCH_TIMEOUT_MS" \
    --log-every="$BENCH_LOG_EVERY" \
    --checkpoint-every="$BENCH_CHECKPOINT_EVERY" \
    --retries="$BENCH_RETRIES" \
    --gen="$GEN_LABEL" 2>&1 | tee "${TEE_ARGS[@]}" "$GEN_SNAPSHOT/run.log"; then
    echo "  ⚠ Benchmark command exited non-zero. If a checkpoint exists, the next loop pass will resume it."
  fi

  SCORES_FILE="$RESULTS_DIR/${GEN_LABEL}_scores.json"
  if [ ! -f "$SCORES_FILE" ]; then
    echo "  ✗ No scores file, skipping generation"
    continue
  fi

  NUMERIC_SCORE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCORES_FILE','utf-8')).score.toFixed(2))")
  WEAK_CAT=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$SCORES_FILE','utf-8'));
    const sorted = Object.entries(s.catScores).sort((a,b) => a[1].sum/a[1].count - b[1].sum/b[1].count);
    console.log(sorted[0]?.[0] || 'unknown');
  ")

  echo ""
  echo "  Score: ${NUMERIC_SCORE}% (best: ${BEST_SCORE}%)"
  echo "  Weakest: $WEAK_CAT"

  cp "$SCORES_FILE" "$GEN_SNAPSHOT/"

  KEEP=$(node -e "console.log(parseFloat('$NUMERIC_SCORE') > parseFloat('$BEST_SCORE') ? 1 : 0)")

  if [ "$KEEP" = "1" ]; then
    echo "  ✅ IMPROVEMENT! ($BEST_SCORE% → $NUMERIC_SCORE%)"
    BEST_SCORE="$NUMERIC_SCORE"
  else
    echo "  ❌ No improvement. Reverting src/ to previous best."
    BEST_GEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCOREBOARD','utf-8')).best_gen || 'none')")
    if [ "$BEST_GEN" != "none" ] && [ -d "$GEN_DIR/$BEST_GEN/src_after" ]; then
      cp "$GEN_DIR/$BEST_GEN/src_after/"*.mjs "$SRC_DIR/"
      cd "$PROJECT" && npm run build 2>/dev/null
      echo "  → Reverted to $BEST_GEN"
    fi
  fi

  node -e "
    const fs = require('fs');
    const sb = JSON.parse(fs.readFileSync('$SCOREBOARD','utf-8'));
    sb.generations = (sb.generations || []).filter((g) => g.gen !== '$GEN_LABEL');
    sb.generations.push({
      gen: '$GEN_LABEL',
      score: parseFloat('$NUMERIC_SCORE'),
      best: parseFloat('$BEST_SCORE'),
      weak_cat: '$WEAK_CAT',
      diff_lines: parseInt('$DIFF_LINES') || 0,
      kept: $KEEP === 1,
      timestamp: new Date().toISOString()
    });
    if (parseFloat('$NUMERIC_SCORE') > sb.best_score) {
      sb.best_score = parseFloat('$NUMERIC_SCORE');
      sb.best_gen = '$GEN_LABEL';
    }
    fs.writeFileSync('$SCOREBOARD', JSON.stringify(sb, null, 2));
  "

  echo ""
  echo "  📊 Scoreboard: gen=$GEN score=${NUMERIC_SCORE}% best=${BEST_SCORE}%"
  echo ""
done

# ── Final Report ──
echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║  EVOLUTION COMPLETE                                   ║"
echo "║                                                       ║"
echo "║  Generations:  $GEN                                   ║"
echo "║  Best score:   ${BEST_SCORE}%                         ║"
echo "║  Best gen:     $(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCOREBOARD','utf-8')).best_gen)")  ║"
echo "║  Scoreboard:   $SCOREBOARD                            ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "  Generation snapshots in: $GEN_DIR/"
echo "  Each contains: src_before/ src_after/ mutation.diff scores.json"
echo ""
