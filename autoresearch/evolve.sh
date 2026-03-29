#!/bin/bash
# evolve.sh — Autoresearch RL loop for cloclo self-improvement
#
# Usage: ./evolve.sh [hours] [model]
# Example: ./evolve.sh 8 gpt-5.4
#
# Flow per generation:
#   1. Cloclo (GPT-5.4) answers 1000 questions (parallel, ~5min)
#   2. Score against Claude ground truth
#   3. Find weakest category
#   4. Claude modifies src/*.mjs to improve
#   5. npm run build → rebuild cloclo
#   6. Save generation snapshot
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
  CURRENT_MAX_LABEL="gen_$(printf '%03d' "$GEN")"
  if [ "$GEN" -gt 0 ] && [ -d "$GEN_DIR/$CURRENT_MAX_LABEL" ] && [ ! -f "$RESULTS_DIR/${CURRENT_MAX_LABEL}_scores.json" ]; then
    GEN_LABEL="$CURRENT_MAX_LABEL"
    echo "  ↺ Resuming incomplete generation $GEN_LABEL"
  else
    GEN=$((GEN + 1))
    GEN_LABEL="gen_$(printf '%03d' "$GEN")"
  fi
  GEN_SNAPSHOT="$GEN_DIR/$GEN_LABEL"
  REMAINING=$(( (END_TIME - $(date +%s)) / 60 ))

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  GENERATION $GEN [$GEN_LABEL] — ${REMAINING}min remaining"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # ── Step 1: Save snapshot BEFORE ──
  mkdir -p "$GEN_SNAPSHOT/src_before"
  cp "$SRC_DIR"/*.mjs "$GEN_SNAPSHOT/src_before/"

  # ── Step 2: Run cloclo on 1000 questions (parallel) ──
  echo "  → Running cloclo ($MODEL) on 1000 questions..."
  if ! node "$DIR/run-cloclo-parallel.mjs" \
    --model="$MODEL" \
    --concurrency="$BENCH_CONCURRENCY" \
    --timeout-ms="$BENCH_TIMEOUT_MS" \
    --log-every="$BENCH_LOG_EVERY" \
    --checkpoint-every="$BENCH_CHECKPOINT_EVERY" \
    --retries="$BENCH_RETRIES" \
    --gen="$GEN_LABEL" 2>&1 | tee "$GEN_SNAPSHOT/run.log"; then
    echo "  ⚠ Benchmark command exited non-zero. If a checkpoint exists, the next loop pass will resume it."
  fi

  # ── Step 3: Extract score ──
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

  # Save scores to snapshot
  cp "$SCORES_FILE" "$GEN_SNAPSHOT/"

  # ── Step 4: Keep or revert decision ──
  KEEP=$(node -e "console.log(parseFloat('$NUMERIC_SCORE') > parseFloat('$BEST_SCORE') ? 1 : 0)")

  if [ "$KEEP" = "1" ]; then
    echo "  ✅ IMPROVEMENT! ($BEST_SCORE% → $NUMERIC_SCORE%)"
    BEST_SCORE="$NUMERIC_SCORE"
  else
    echo "  ❌ No improvement. Reverting src/ to previous best."
    # Find the best generation's src and restore it
    BEST_GEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$SCOREBOARD','utf-8')).best_gen)")
    if [ -d "$GEN_DIR/$BEST_GEN/src_after" ]; then
      cp "$GEN_DIR/$BEST_GEN/src_after/"*.mjs "$SRC_DIR/"
      cd "$PROJECT" && npm run build 2>/dev/null
      echo "  → Reverted to $BEST_GEN"
    fi
  fi

  # ── Step 5: Claude mutates src/ ──
  echo "  → cloclo ($MUTATOR_MODEL) is analyzing and mutating src/..."

  # Get top 3 weak categories for context
  WEAK_CATS=$(node -e "
    const s = JSON.parse(require('fs').readFileSync('$SCORES_FILE','utf-8'));
    const sorted = Object.entries(s.catScores).sort((a,b) => a[1].sum/a[1].count - b[1].sum/b[1].count);
    console.log(sorted.slice(0,3).map(([c,d]) => c + ' (' + (d.sum/d.count*100).toFixed(1) + '%)').join(', '));
  ")

  # Use cloclo with GPT-5.4 to make the mutation
  if ! node "$PROJECT/claude-native.mjs" --model "$MUTATOR_MODEL" -p "You are optimizing cloclo CLI to score better on benchmarks.

Current score: ${NUMERIC_SCORE}%. Best: ${BEST_SCORE}%.
Weakest categories: $WEAK_CATS

Read ~/claude-tool-loop/autoresearch/program.md for full directives.
Read ~/claude-tool-loop/autoresearch/results/${GEN_LABEL}_scores.json for detailed scores.

Then:
1. Read the relevant src/ file(s) for the weakest category
2. Make ONE targeted improvement
3. Run: cd ~/claude-tool-loop && npm run build
4. Run: cd ~/claude-tool-loop && npm test (verify nothing broke)

Focus on '$WEAK_CAT'. Small, surgical change only." 2>&1 | tee "$GEN_SNAPSHOT/mutation.log"; then
    echo "  ⚠ Mutation step exited non-zero. Continuing with the current src/ state."
  fi

  # ── Step 6: Save snapshot AFTER ──
  mkdir -p "$GEN_SNAPSHOT/src_after"
  cp "$SRC_DIR"/*.mjs "$GEN_SNAPSHOT/src_after/"

  # Save diff
  diff -ru "$GEN_SNAPSHOT/src_before" "$GEN_SNAPSHOT/src_after" > "$GEN_SNAPSHOT/mutation.diff" 2>/dev/null || true
  DIFF_LINES=$(wc -l < "$GEN_SNAPSHOT/mutation.diff" 2>/dev/null || echo 0)
  echo "  → Mutation diff: $DIFF_LINES lines changed"

  # ── Step 7: Rebuild ──
  echo "  → Rebuilding cloclo..."
  cd "$PROJECT" && npm run build 2>/dev/null
  echo "  → Build complete"

  # ── Step 8: Update scoreboard ──
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
