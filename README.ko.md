# OMO Linear Workflow (OLW)

[English](README.md) | 한국어

OLW는 Linear에서 승인된 범위를 실제 작업 세션으로 바꾸는 Bun CLI입니다. 사용자가 대화하는 매니저, 프로젝트마다 부모 하나, 이슈마다 자식 하나가 각자의 Herdr workspace에서 OMO를 실행합니다. 범위와 결정은 Linear가 소유합니다. 로컬 SQLite는 승인된 snapshot, 실행 권한, runtime identity와 delivery receipt를 보관합니다.

## 흐름

```
사용자
 |  질문은 위로, 답은 아래로
 v
매니저 세션 ............... OLW host, 사용자의 OMO 기본 모델
 |
 v
프로젝트 부모 ............. 프로젝트마다 clone 하나
 |
 +-- 이슈 자식 (direct / research) ... 이슈마다 worktree 하나
 |
 +-- 이슈 자식 (planned)
       plan 단계 -> execute 단계 ..... 같은 worktree, 탭 두 개
```

자식은 부모에게 묻고, 부모는 매니저에게 묻고, 사용자에게 묻는 역할은 매니저뿐입니다. 매니저가 없으면 질문은 사용자 inbox에 쌓입니다(`questions`, `answer --as-user`). 자식은 부모의 통합 브랜치로 PR을 올리거나, 이슈가 요구하면 report나 document를 냅니다.

## 요구 사항

- Linux x64
- Bun >= 1.4.0, Node.js >= 24.20.0, pnpm 10.33.3, Git
- OMO 연동을 켠 opencodex: `ocx integration client enable --client omo`
- Herdr는 따로 설치하지 않습니다. 빌드가 공식 Herdr 0.9.1 릴리즈를 내려받아 고정된 SHA-256을 검증합니다. Rust나 Zig는 필요 없습니다.

## 설치

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
bun run install:local
olw doctor --json
```

설치기는 Herdr를 포함한 전체를 빌드하고 `~/.local/bin/olw`를 만듭니다. 설치한 체크아웃은 그 자리에 두세요. 옵션, 제거 방법, 설치기가 건드리지 않는 것은 [설치 세부](docs/operations.md#install-details)에 있습니다.

`olw doctor`는 로컬 런타임을 점검하고, 기존 linked-worktree 부모가 남아 있으면 공식 Herdr 전환을 막습니다. [전환 조건](docs/operations.md#official-herdr-runtime-and-switch-gate)을 참고하세요.

## 빠른 시작

Herdr의 아무 pane에서 `olw`를 입력하세요. 현재 pane에서 매니저를 열거나, 이미 실행 중인 매니저 pane으로 이동합니다. TUI를 종료한 뒤 다시 `olw`를 입력하면 같은 대화를 현재 pane에 다시 연결합니다. 일반 작업에서는 평소처럼 어시스턴트로 동작하며, OLW 메시지를 처리할 때만 OLW 지침을 적용합니다.

```sh
olw
# 다른 pane에서 프로젝트 작업을 승인하고 시작합니다:
olw scope import --file approved-scope.json --json
olw parent create --scope-digest DIGEST --designation ID --execute --project ID --json
olw child create --parent BINDING --issue ID --mode planned --json
olw status --project ID --json
```

`DIGEST`는 import 응답의 `value.digest`, `BINDING`은 create 응답의 `value.binding.id`입니다. 프로젝트의 대상 저장소는 승인된 [scope 저장소 매핑](docs/repositories.md)에서 가져오며 `--repo`는 거부됩니다. 로컬 fixture `tests/fixtures/scope.json`을 가져올 때는 `--fixture`를 붙입니다.

## 명령

| 명령 | 하는 일 |
| --- | --- |
| `doctor` | 로컬 런타임, 저장소 mirror, 기존 부모를 점검 |
| `olw` / `manage --here` | 현재 Herdr pane에서 매니저를 열거나 다시 연결. 이미 실행 중이면 해당 pane으로 이동 |
| `manage` | 별도 workspace에서 매니저를 열거나, 기존 매니저로 이동·재연결 |
| `update check` | 고정된 OMO와 Senpi 버전을 npm과 비교. 설치하지 않음 |
| `update prepare` | 버전 갱신을 별도 worktree에서 검증하고 `dev`로 PR을 올림 |
| `scope import` | 승인된 Linear snapshot을 가져오고 digest를 반환 |
| `repo list` / `repo fetch` | 대상 저장소의 bare fetch 전용 mirror를 나열하거나 갱신 |
| `supervisor create` | 선택적인 initiative 감독 세션을 생성 |
| `parent create` | 프로젝트 부모를 전용 clone에 생성 |
| `parent link` / `parent unlink` | 부모를 감독이나 매니저에 연결하거나 그 연결을 해제 |
| `child create` | 이슈 자식을 생성 (`--mode direct`, `planned`, `research`; `--deliverable pr`, `report`, `document`) |
| `pr open` / `pr merge` | 자식 또는 프로젝트 PR을 열고, 자식 PR을 통합 브랜치에 병합 |
| `stage complete` | 끝난 plan 단계를 계획 파일과 head commit과 함께 기록 |
| `stage start` | 같은 worktree에서 execute 단계를 시작 |
| `send` | 역할 사이에 `instruction` 또는 `coordination` 메시지를 전송 |
| `report` | `completed`, `blocked`, `failed` 결과를 부모, 매니저 또는 사용자 inbox(`--to-user`)에 보고 |
| `reports` | 게시된 사용자 inbox를 읽음. `--all`은 매니저에게 보낸 보고도 포함 (읽기 전용) |
| `ask` | 막힌 질문을 위로 올림 (부모 전용; 자식은 `olw_ask` 도구 사용) |
| `answer` | 질문 ID 하나에 역할(`--from`) 또는 사용자(`--as-user`)로서 답함 |
| `questions` / `notices` | 열린 질문 또는 운영 알림 목록 (읽기 전용) |
| `status` | 프로젝트 또는 initiative의 저장된 상태를 표시 |
| `pause` / `resume` | 역할에 대한 새 연락을 막거나 다시 허용 |
| `close` | 역할을 닫되 clone, worktree, 브랜치, 세션 기록은 보존 |
| `reconcile` | 모든 활성 역할을 Herdr와 native host에 대해 한 번 대조 |

모든 명령은 `--root PATH`, `--herdr-socket PATH`, `--json`을 받습니다. 정확한 옵션은 `olw --help --json`으로 확인합니다. 종료 코드는 성공 0, 잘못된 입력 2, runtime unavailable 3, uncertain outcome 4입니다.

## 역할과 모델

| 역할 | 모델 / reasoning |
| --- | --- |
| 매니저 | `~/.omo/agent/settings.json`의 OMO 기본 모델 (없으면 `anthropic/claude-opus-5-5` / medium) |
| 부모 | `anthropic/claude-opus-5-5` / xhigh |
| 자식, `direct` 또는 `research` | `anthropic/claude-opus-5-5` / xhigh |
| 자식, `planned` plan 단계 | `anthropic/claude-fable-5-1` / xhigh |
| 자식, `planned` execute 단계 | `anthropic/claude-opus-5-5` / medium |
| 감독 (선택) | `gpt-6-astra` / high |

모든 모델은 opencodex를 통해 제공됩니다. 기존 binding은 시작할 때의 모델을 유지하고, 매니저만 모델을 자유롭게 바꿀 수 있습니다. 업스트림 라우팅은 기본적으로 고정되어 검토만 하고 조용히 적용하지 않습니다. [고정 라우팅](docs/proxy-routing.md)을 참고하세요.

## 문서

- [운영 안내](docs/operations.md): 설치 세부, opencodex, scope import, 역할, 동작, 공식 Herdr와 롤백, 검증, 복구, 제한
- [저장소 mirror, 소유 clone과 PR 통합](docs/repositories.md)
- [2단계 자식과 질문 에스컬레이션](docs/two-stage-children.md)
- [opencodex를 통한 고정 라우팅](docs/proxy-routing.md)
- [런타임 수정 안내](docs/runtime-patches.md)
- 정책: [이슈](docs/policy/issues.md), [PR](docs/policy/pull-requests.md), [CI](docs/policy/ci.md), [릴리즈](docs/policy/releases.md)
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases)

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)부터 읽어 주세요. PR은 `dev`를 대상으로 하고, `main`은 릴리즈된 소스입니다. 민감한 문제는 [SECURITY.md](SECURITY.md)의 절차로 알려 주세요.
