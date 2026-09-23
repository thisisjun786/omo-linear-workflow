# OMO Linear Workflow (OLW)

[English](README.md) | 한국어

Linear에서 승인된 initiative 범위를 Herdr worktree와 OMO native thread에 연결하는 Bun CLI입니다. Linear가 범위와 결정을 소유하고, 로컬 SQLite는 승인된 snapshot, 실행 권한, runtime identity와 delivery receipt를 보관합니다.

## 준비

공식 설치 대상은 **Linux x64**입니다. Bun >=1.4.0, Node.js >=24.20.0,
pnpm 10.33.3과 Git을 먼저 준비합니다. Node/npm 설치 후
`npm install --global pnpm@10.33.3`으로 필요한 pnpm 버전을 선택할 수 있습니다.
그다음 계속 유지할 경로에 저장소를 받습니다.

```sh
git clone https://github.com/thisisjun786/omo-linear-workflow.git ~/code/omo-linear-workflow
cd ~/code/omo-linear-workflow
bun run install:local
"$HOME/.local/bin/olw" --help
bun run herdr --version
bun run cli -- doctor --json
```

설치기는 lockfile을 고정한 의존성 설치와 관리형 전체 빌드를 실행한 뒤
`~/.local/bin/olw`를 만듭니다. 다른 경로는
`bun run install:local -- --bin-dir "$HOME/bin"`으로 지정합니다. 인수는 실행기
파일명이 아닌 디렉터리입니다. `bun run install:local --help`에서 옵션을 확인할 수 있습니다. 다른 프로그램의
파일이나 심볼릭 링크는 덮어쓰지 않고, 같은 체크아웃에서 재실행할 수 있습니다.
설치한 체크아웃 경로를 유지하고 필요하면 bin 디렉터리를 PATH에 직접 추가합니다.
실행기는 호출한 작업 디렉터리를 보존하고 이 체크아웃을 기본 control root로 사용합니다.

선행 도구 자동 설치, 셸 설정 편집, 인증 설정, 프록시 정책 변경, 서비스·세션
재시작은 하지 않습니다. 기존 `omo` 실행기도 교체하지 않습니다. 제거할 때는
설치된 `olw` 실행기를 확인한 뒤 그 파일만 삭제합니다. 체크아웃, `.omo/` 상태와
외부 접근 파일은 그대로 남습니다.

`git`이 PATH에 있어야 합니다. 최초 빌드는 Rustup의 Rust 1.96.1과 Zig 0.16.0을 사용해
OMO 지원 패치가 포함된 Herdr도 함께 준비합니다. `cargo`나 `zig`가 PATH에 없다면
`CARGO`와 `ZIG` 환경변수로 실행 파일을 지정합니다. 이후 빌드는 검증된 산출물을
재사용하므로 Herdr를 매번 컴파일하지 않습니다.

Herdr는 별도로 맞춰 설치하는 선택 항목이 아니라 OLW의 필수 관리형 런타임입니다.
`bun run herdr`로 이 빌드를 실행할 수 있으며, OLW 역할 생성은 Herdr 안에서 실행합니다.
TUI와 공유 호스트는 이 저장소의 `node_modules/.bin/omo`를 실행하므로 전역 OMO 업데이트와 버전이 섞이지 않습니다. 아래 역할 모델을 제공하는 CLIProxyAPI와 프록시 접근 설정도 필요합니다.
이 저장소가 제공사 자격 증명을 발급하거나 복사하지는 않습니다. 계정 로그인은 CLIProxyAPI에서 관리합니다.

## 기여와 릴리즈

[CONTRIBUTING.md](CONTRIBUTING.md)는 이슈, 변경 단위별 PR, 검증과 리뷰 규칙을
설명합니다. GitHub에는 버그·기능 요청 양식과 PR 템플릿이 제공됩니다.
[버전·릴리즈 정책](docs/releases.md)은 SemVer, `vVERSION` 태그, 소스 배포,
업그레이드와 롤백을 다룹니다. 릴리즈 노트는 [CHANGELOG.md](CHANGELOG.md)에
기록하며, `bun run release:check`로 패키지 버전과 노트를 검증합니다.
CI는 제공자 인증 없이 필수 네이티브 Herdr 빌드와 격리 설치 검사까지 실행합니다.
관리자가 버전 태그를 푸시하면 이 검사들이 통과한 뒤 GitHub 릴리즈를 발행합니다.
위 clone 명령은 `main`을 설치합니다. 첫 릴리즈를 설치하려면 `--branch v0.1.0`을
추가합니다. 발행된 버전과 소스 압축 파일은
[GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases)에서 확인합니다.

## 프록시 모델 확장

`bun run build`는 세션 제어용 `dist/extension/index.js`와 모델 연결용
`dist/proxy/index.js`를 각각 만듭니다. 새 OLW 역할 세션과 생성된 공유 호스트
프로필은 둘 다 명시적으로 로드하므로 사용자 전역 확장 설정에 의존하지 않습니다.
프록시 확장만 일반 OMO에서 사용할 수도 있습니다.

```sh
omo -e /absolute/path/to/omo-linear-workflow/dist/proxy/index.js
```

OMO의 `settings.json`에 있는 `extensions` 배열에 같은 경로를 등록하면 다음
시작부터 로드합니다. 기존 독립 프록시 확장 경로는 함께 등록하지 않습니다.

접근 파일은 기본적으로 아래 두 곳에서 읽습니다. 예시의 키를 실제 값으로 바꾸고
파일 권한을 `600`으로 유지합니다. 저장소에는 키나 제공사 OAuth 파일을 넣지 않습니다.

`~/.config/cliproxyapi/omo-client.json`:

```json
{"baseUrl":"http://127.0.0.1:8317/v1","apiKey":"CLIENT_KEY"}
```

`~/.config/cliproxyapi/management-access.json`:

```json
{"managementUrl":"https://your-host:8318/management.html","managementKey":"MANAGEMENT_KEY"}
```

클라이언트 키는 모델 호출에, 관리 키는 모델 정의와 별칭 조회에 사용합니다.
`/v1/models`와 관리 메타데이터를 합쳐 채팅 모델을 등록하고, 시작·새 에이전트 실행·
`/proxy-refresh` 때 갱신합니다. 일부 메타데이터 조회가 실패하면 마지막 성공 목록을
유지합니다. 불완전한 개별 모델은 경고와 함께 제외하며 이미지·영상 생성 전용
모델은 등록하지 않습니다. 요청 직전에 가용성을 검사하고 실제 Responses,
Messages 또는 Chat Completions 전송으로 연결합니다.

`models.json`의 `providers.cliproxyapi.modelOverrides`는 컨텍스트 등 사용자 설정에
계속 적용됩니다. 카테고리·에이전트의 업스트림 모델 체인은 관리형 OMO 런처가
시작 전에 확인하고 프록시 경로로 동기화합니다. OLW 역할별 명시적 모델 지정은
별도로 유지합니다. 이 기능이 다른 제공자를 활성화하거나 직접 인증을 복원하지는 않습니다.
등록 가격이 없는 모델의 비용 `0`은 무료가 아니라 정보 없음입니다.

### 모델 등록과 비활성화 정책

모델 등록과 사용 여부는 사용자가 CLIProxyAPI 관리 화면에서 직접 관리합니다.
OAuth 모델은 **OAuth Model Disablement**로 켜고 끄며, OLW는 이 정책을 읽기만 합니다.
수동 등록·활성화·비활성화가 자동 라우팅 추천보다 우선합니다. 현재 OMO 목록 제한은
`scope all`로 해제했고, 시작할 때 미사용 모델을 자동으로 다시 차단하지 않습니다.
MiMo처럼 직접 등록한 OpenAI 호환 제공자는 OAuth 정책 대상이 아니므로 별도 모델
등록 목록을 보존합니다. 관리 파일·예외·복구 절차는
[수동 우선 모델 정책](docs/proxy-model-policy.md)을 따릅니다.

### 업스트림 라우팅 자동 추적

일반 `omo`·`omon` 시작과 OLW 공유 호스트 준비 전에 설치된 전역 OMO의 버전과
실제 정책 번들 해시를 확인합니다. 변경되면 카테고리·에이전트 모델 순서와 사고 수준을
현재 프록시 목록에 맞춰 반영합니다. 이후 사용자가 직접 바꾼 라우팅은 보호하고,
매핑할 수 없는 체인이나 새로운 번들 형식이면 이전 설정을 유지한 채 오류를 알립니다.
현재 세션을 재시작하거나 OLW의 Parent·Child 모델 지정을 바꾸지는 않습니다.

```sh
bun run proxy:routing status
bun run proxy:routing check --force
bun run proxy:routing sync --force
```

최초 활성화·소유 범위·복구와 실행 경로는
[자동 라우팅 운영 안내](docs/proxy-routing.md)에 있습니다.

검증: `bun test tests/proxy`, `bun run typecheck`, `bun run qa:proxy`.
마지막 명령은 실제 계정을 사용해 세 역할 모델의 파일 읽기 도구 호출을 검증합니다.
로컬 접근 파일이 필요하며 Herdr 작업 공간이나 기존 역할 세션을 만들거나 바꾸지 않습니다.

Linear 인증과 조회는 OMO의 기존 Linear MCP 연결을 사용합니다. 인증이 필요하면 사용자가 `/mcp auth linear`를 실행합니다. 이후 `skills/define/SKILL.md`(`olw-define`), `skills/plan/SKILL.md`(`olw-plan`)를 읽도록 요청해 revision이 고정된 snapshot을 준비합니다. import는 원격 인증이나 최신 revision을 증명하지 않으므로 skill의 MCP 확인 절차를 생략하면 안 됩니다. 로컬 QA fixture인 `tests/fixtures/scope.json`에는 반드시 `--fixture`를 붙입니다.

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
| Supervisor | `cliproxyapi/gpt-6-astra` / `high` | control root Herdr workspace |
| Parent | `cliproxyapi/claude-opus-5-5` / `xhigh` | project integration branch worktree |
| Child | `cliproxyapi/claude-opus-5-5` / `xhigh` | parent branch 기반 issue worktree |

이 배정은 새 binding에 적용됩니다. 기존 binding은 초기 세션 기록의 모델·제공자·
사고 수준을 검증 기준으로 유지하며, reconcile이 실행 중 세션을 새 정책으로
자동 전환하지 않습니다.

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

`qa:events`는 격리 Herdr server와 Git fixture에서 세 역할의 실제 모델, worktree ancestry, focus 유지, 보고에 따른 자동 재개, 중복 방지, runtime 유실 감지와 종료 시 데이터 보존을 검사하고 자원을 정리합니다. 기본 Herdr는 관리형 산출물이며 QA control root에도 같은 manifest·patch·receipt를 전달합니다. `qa:linear`는 실제 OMO MCP 실행 경로에 로컬 HTTP fixture를 연결하고 네 개 skill의 로딩을 확인합니다. 다른 서버 빌드와의 호환성을 시험하려면 `QA_HERDR_BINARY=/abs/herdr`를 명시합니다. 격리 QA 성공만으로 현재 사용 중인 서버의 TUI 동작까지 검증됐다고 간주하지 않습니다.

## 복구와 종료

`status`는 저장된 상태를 보여줍니다. `reconcile`은 모든 활성 역할의 Herdr 자원과 실제 native identity를 한 번 확인합니다. 사라진 역할은 `uncertain`으로 바꾸고 자동으로 재생성하지 않습니다. 이미 요청했던 종료는 이어서 처리할 수 있습니다.

`close`는 자식부터 실행합니다. 해당 workspace와 정확한 native 세션을 닫은 뒤 소유권을 해제하며, **worktree 파일·브랜치·세션 기록은 보존합니다**. 다른 클라이언트가 native 세션에 붙어 있거나 자원 신원이 달라졌으면 소유권을 유지한 채 오류를 반환합니다. 관찰 클라이언트를 분리한 뒤 다시 실행하면 됩니다.

workspace 생성 응답 자체가 유실됐다면 Herdr를 직접 확인해야 합니다. 생성된 workspace가 없음을 확인한 경우에만 `close --binding ID --confirm-absent`로 미확정 예약을 해제합니다. 종료한 역할은 다시 열지 않고, 같은 승인에 새 binding을 만듭니다.

## 제한

하나의 Herdr server와 하나의 native OMO host를 사용합니다. 자동 merge, release, Linear mutation은 제공하지 않습니다. native acceptance, 작업 완료 보고, Linear acceptance는 서로 다른 상태입니다. `pause`와 `resume`은 연락 허용 상태만 바꾸며 세션을 재생성하지 않습니다. 종료나 불확실한 작업 결과가 Linear 완료를 뜻하지는 않습니다.

실제 Herdr/모델/보고 QA는 통과했습니다. Live Linear OAuth와 실제 Linear 쓰기는 실행하지 않았습니다. 기본 Herdr의 OMO 탐지 지원 여부는 이 CLI의 실행·통신과 별개입니다.

## 관리형 Herdr

[고정 manifest](vendor/herdr/manifest.json), [OMO 지원 패치](patches/herdr-0.9.1-omo.patch),
[빌드·업데이트·복구 안내](vendor/herdr/README.md)가 Herdr의 소유 지점입니다.
업스트림 커밋과 패치 해시, Rust/Zig 버전으로 산출물 위치를 구분하고,
실행 전 receipt와 실행 파일의 SHA-256을 검증합니다. 누락되거나 다른 산출물이면
전역 PATH의 Herdr로 조용히 대체하지 않습니다.

`bun run build`가 Herdr를 포함한 전체 런타임을 준비하고, `bun run herdr:build`는
Herdr 단계만 실행합니다. 새 역할 TUI와 공유 호스트에는 이 바이너리 디렉터리가
PATH 앞에 전달됩니다. 기존 서버·binding·workspace를 자동 재시작하거나 이전하지 않습니다.

통합 당시 재빌드한 Linux x64 바이너리는 기존 설치본 및 실제 실행 중인 서버와
SHA-256이 같았습니다. 원래 `~/code/herdr-omo-0.9.1`과 과거 `~/code/herdr-omo`는
보존했지만, 향후 빌드는 그 외부 소스 트리에 의존하지 않습니다.
검증 기록은 [관리형 Herdr 증거](.omo/evidence/managed-herdr-integration.md)에 있습니다.
