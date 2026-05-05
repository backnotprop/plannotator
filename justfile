repo_root := justfile_directory()
planning_justfile := env_var("HOME") / "gitclones/ai/planning/justfile"

derive-tags target="plans/features":
  @just --justfile {{planning_justfile}} derive-tags {{repo_root / target}}

check-schema target="plans/features":
  @just --justfile {{planning_justfile}} check-schema {{repo_root / target}} {{repo_root / ".nimbalyst/trackers"}}

dag target="plans/features" out="plans/plan-dag.md":
  @just --justfile {{planning_justfile}} dag {{repo_root / target}} {{repo_root / out}} {{repo_root / ".nimbalyst/trackers"}}

validate target="plans/features" schema_dir=".nimbalyst/trackers" out="plans/plan-dag.md":
  @just --justfile {{planning_justfile}} validate {{repo_root / target}} {{repo_root / schema_dir}} {{repo_root / out}}

install-planning-schemas dest=".nimbalyst/trackers":
  @just --justfile {{planning_justfile}} install-schemas {{repo_root / dest}}
