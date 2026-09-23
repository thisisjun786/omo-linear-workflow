# OMO Initiative

Linear에서 승인된 initiative 범위를 Herdr worktree와 OMO native thread에 연결하는 Bun CLI입니다. Linear가 범위와 결정을 소유하고, 로컬 SQLite는 승인된 snapshot, 실행 권한, runtime identity와 delivery receipt를 보관합니다.

## 준비

```sh
cd ~/code/omo-initiative
pnpm install
bun run build
bun run cli -- doctor --json
bun run cli -- --help
```

설치된 `herdr`, `git`이 PATH에 있고 Herdr 안에서 실행해야 합니다. TUI와 공유 호스트는 이 저장소의 `node_modules/.bin/omo`를 실행하므로 전역 OMO 업데이트와 버전이 섞이지 않습니다. 역할 모델 세 개의 OMO 인증도 필요합니다.
이 저장소가 자격 증명을 발급하거나 복사하지는 않습니다. 기존 OMO에서 아래 세 모델을 실제로 호출할 수 있는 상태여야 합니다.

Linear 인증과 조회는 OMO의 기존 Linear MCP 연결을 사용합니다. 인증이 필요하면 사용자가 `/mcp auth linear`를 실행합니다. 이후 `skills/define/SKILL.md`, `skills/plan/SKILL.md`를 읽도록 요청해 revision이 고정된 snapshot을 준비합니다. import는 원격 인증이나 최신 revision을 증명하지 않으므로 skill의 MCP 확인 절차를 생략하면 안 됩니다. 로컬 QA fixture인 `tests/fixtures/scope.json`에는 반드시 `--fixture`를 붙입니다.

Snapshot 형식은 [`tests/fixtures/scope.json`](tests/fixtures/scope.json)을 참고합니다. 로컬 입력 확인은 다음처럼 실행할 수 있습니다.

```sh
bun run cli -- scope import --file tests/fixtures/scope.json --fixture --json
```

`--scope-digest`에는 import 응답의 `value.digest`를 사용합니다. 파일을 직접 해싱한 값이 아닙니다. `--designation`은 이 실행을 구분하는 고유한 이름이고, `BINDING`은 각 create 응답의 `binding.id`입니다(`--json`에서는 `value.binding.id`).

## 명령

```sh
bun run cli -- --root "$PWD" scope import --file approved-scope.json
bun run cli -- --root "$PWD" supervisor create --initiative ID --scope-digest SHA --designation ID --execute
bun run cli -- --root "$PWD" parent create --supervisor BINDING --project ID --repo /abs/repo --base main
bun run cli -- --root "$PWD" child create --parent BINDING --issue ID
bun run cli -- --root "$PWD" send --from BINDING --to BINDING --id MSG --kind instruction --text-file brief.txt
bun run cli -- --root "$PWD" report --from BINDING --id MSG --outcome completed --evidence /abs/path --text-file result.txt
bun run cli -- --root "$PWD" status --initiative ID --json
bun run cli -- --root "$PWD" pause --binding BINDING
bun run cli -- --root "$PWD" resume --binding BINDING
bun run cli -- --root "$PWD" reconcile --initiative ID
bun run cli -- --root "$PWD" close --binding BINDING
```

`--root`는 이 도구의 control root이며 위 예제의 `$PWD`는 이 저장소입니다. 실제 작업 대상 저장소는 parent create의 `--repo`로 별도 지정합니다.

기본 Herdr socket은 현재 pane의 `HERDR_SOCKET_PATH`를 사용합니다. 다른 서버를 선택할 때만 `--herdr-socket /abs/socket`을 지정합니다. 격리 QA 서버의 생성·종료는 아래 QA 스크립트가 맡습니다. 종료 코드는 성공 0, 잘못된 범위/입력 2, runtime unavailable 3, uncertain outcome 4입니다.

## 역할

| 역할 | 모델 / reasoning | 작업 공간 |
| --- | --- | --- |
| Supervisor | `chatgpt-subscription/gpt-6-astra` / `high` | control root Herdr workspace |
| Parent | `kimi-coding/k3` / `max` | project integration branch worktree |
| Child | `anthropic-subscription/claude-opus-5` / `xhigh` | parent branch 기반 issue worktree |

## 동작

Herdr가 workspace와 부모·자식 worktree를 만듭니다. 부모 브랜치는 `omo/<designation>/projects/<project>-<binding>`, 자식 브랜치는 `omo/<designation>/issues/<issue>-<binding>`이며, 자식의 base는 부모 브랜치의 확인된 commit입니다. 새 binding suffix 덕분에 이전 작업 브랜치를 보존한 채 역할을 교체할 수 있습니다.

컨트롤러가 파일 이벤트를 먼저 구독한 뒤 OMO를 실행합니다. TUI의 `session_start`가 `.omo/state/ready/`에 원자적으로 준비 기록을 남기면, 공개 OMO RPC로 정확한 세션에 연결해 모델과 reasoning을 설정·검증한 후 첫 지시를 보냅니다. Herdr의 OMO 탐지나 미지원 session-path 보고에 의존하지 않습니다.

초기 지시는 보내기 전에 영속 claim을 남깁니다. 실제 수락이 확인되기 전에는 `initializing`이며, 수락 후에만 `ready`가 됩니다. ACK가 유실되면 이미 저장된 정확한 user message 또는 delivery receipt로 확인하고, 증거가 없으면 재전송하지 않습니다.

이후 세션 간 연락은 네이티브 `thread_send`의 `delivery: auto`를 사용합니다. 대기 중인 부모는 자식 보고로 재개되며, 별도 에이전트 polling loop나 자체 메시지 broker는 없습니다. 동일 message ID와 동일 payload는 저장된 receipt를 반환하고 다시 전송하지 않습니다.

네이티브 thread 도구가 대상 작업 저장소에 `.omo/thread-tools/`를 만들 수 있습니다. 작업 저장소의 ignore 규칙에 이 runtime 경로를 포함하면 생성 파일이 commit이나 worktree 정리를 방해하지 않습니다.

```gitignore
.omo/thread-tools/
```

## 검증

```sh
bun test
bun run typecheck
bun run lint
bun run build
bun run qa:events
bun run qa:linear
```

`qa:events`는 격리 Herdr server와 Git fixture에서 세 역할의 실제 모델, worktree ancestry, focus 유지, 보고에 따른 자동 재개, 중복 방지, runtime 유실 감지와 종료 시 데이터 보존을 검사하고 자원을 정리합니다. `qa:linear`는 실제 OMO MCP 실행 경로에 로컬 HTTP fixture를 연결하고 네 개 skill의 로딩을 확인합니다. 다른 Herdr 빌드를 시험하려면 `QA_HERDR_BINARY=/abs/herdr`를 지정합니다.

## 복구와 종료

`status`는 저장된 상태를 보여줍니다. `reconcile`은 모든 활성 역할의 Herdr 자원과 실제 native identity를 한 번 확인합니다. 사라진 역할은 `uncertain`으로 바꾸고 자동으로 재생성하지 않습니다. 이미 요청했던 종료는 이어서 처리할 수 있습니다.

`close`는 자식부터 실행합니다. 해당 workspace와 정확한 native 세션을 닫은 뒤 소유권을 해제하며, **worktree 파일·브랜치·세션 기록은 보존합니다**. 다른 클라이언트가 native 세션에 붙어 있거나 자원 신원이 달라졌으면 소유권을 유지한 채 오류를 반환합니다. 관찰 클라이언트를 분리한 뒤 다시 실행하면 됩니다.

workspace 생성 응답 자체가 유실됐다면 Herdr를 직접 확인해야 합니다. 생성된 workspace가 없음을 확인한 경우에만 `close --binding ID --confirm-absent`로 미확정 예약을 해제합니다. 종료한 역할은 다시 열지 않고, 같은 승인에 새 binding을 만듭니다.

## 제한

하나의 Herdr server와 하나의 native OMO host를 사용합니다. 자동 merge, release, Linear mutation은 제공하지 않습니다. native acceptance, 작업 완료 보고, Linear acceptance는 서로 다른 상태입니다. `pause`와 `resume`은 연락 허용 상태만 바꾸며 세션을 재생성하지 않습니다. 종료나 불확실한 작업 결과가 Linear 완료를 뜻하지는 않습니다.

실제 Herdr/모델/보고 QA는 통과했습니다. Live Linear OAuth와 실제 Linear 쓰기는 실행하지 않았습니다. 기본 Herdr의 OMO 탐지 지원 여부는 이 CLI의 실행·통신과 별개입니다.
