# 외부 아바타 작업 API

외부 시스템이 조건과 지시 내용을 정하고, 개인 API 키 소유자의 **메인 아바타**에게 작업을 요청합니다. 예약 작업을 만들지 않습니다. 기존 채팅 실행 경로를 사용하므로 소유자의 도구 정책, 스킬, 지식과 대화 기록을 사용합니다.

## API 키 발급

Noah에서 **내 아바타 → 권한·연결 → 외부 작업 API**를 열고 키 이름을 입력해 발급합니다. 원문은 발급 시 한 번만 표시되며 서버에는 SHA-256 해시만 저장됩니다. 사용자당 최대 10개입니다.

키는 아래 작업 API에만 사용할 수 있으며 로그인 쿠키나 관리자 API 권한을 대신하지 않습니다. 같은 사용자의 다른 개인 API 키로도 자신의 작업을 조회·응답·취소할 수 있습니다. 키 폐기는 새 요청과 해당 키로 접수된 대기 작업을 차단합니다. 이미 실행 중인 작업은 계속되므로 필요하면 Noah 대화의 중지 버튼이나 취소 API를 사용합니다. 정지된 계정의 키는 사용할 수 없습니다.

## 작업 접수

```bash
curl "$NOAH_URL/api/v1/avatar/tasks" \
  -H "Authorization: Bearer $NOAH_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: incident-2026-001' \
  -d '{"message":"서비스 A의 오류 로그를 확인하고 원인과 조치 방법을 정리해 줘"}'
```

`NOAH_URL`은 외부 시스템에서 접근할 수 있는 Noah 서버 주소입니다. API 키는 비밀 환경변수로 보관하고 HTTPS로 호출하세요. 서버 간 호출이므로 브라우저 CORS 설정은 필요하지 않습니다.

| 필드 | 의미 |
|---|---|
| `message` | 필수. 자유로운 작업 지시. UTF-8 기준 최대 64KB |
| `conversationId` | 선택. 이어갈 기존 자신의 메인 아바타 대화 ID. 생략하면 새 대화 생성 |

대상 사용자·다른 아바타·권한 상승 옵션은 받지 않습니다. 메인 아바타만 지원하며 개인 봇·그룹 아바타·외부 아바타는 대상이 아닙니다. 현재 입력은 텍스트이며 이미지 첨부나 모델 선택 필드는 없습니다. 모델·도구 선택은 기존 대화와 사용자 기본 설정을 따릅니다. `message`는 아바타에게 그대로 전달하며 UI 전용 슬래시 명령으로 확장하지 않습니다.

접수는 작업을 SQLite에 저장한 뒤 **202 Accepted**와 `Location` 헤더를 반환합니다. 이는 실행 완료를 의미하지 않습니다.

```json
{
  "task": {
    "id": "task-uuid",
    "conversationId": "conversation-uuid",
    "message": "서비스 A의 오류 로그를 확인하고 원인과 조치 방법을 정리해 줘",
    "status": "queued",
    "runId": null,
    "result": null,
    "error": null,
    "createdAt": "2026-09-06T00:00:00.000Z",
    "updatedAt": "2026-09-06T00:00:00.000Z",
    "pendingRequests": []
  }
}
```

`Idempotency-Key`는 선택 사항입니다. 같은 사용자의 동일 키·동일 본문 재전송은 기존 작업을 **200**으로 반환합니다. 같은 키로 본문을 바꾸면 **409**입니다. 호출 타임아웃 후 재시도하거나 외부 이벤트가 중복 전달될 때 사용하세요. 키는 공백 없는 ASCII 1~128자이며 작업 이력이 유지되는 동안 재사용할 수 없습니다.

## 상태·결과 조회

```bash
curl "$NOAH_URL/api/v1/avatar/tasks/$TASK_ID" \
  -H "Authorization: Bearer $NOAH_API_KEY"
```

응답은 `{ "task": ... }`입니다. `GET /api/v1/avatar/tasks`는 최신 100개를 `{ "tasks": [...] }`로 반환합니다.

| 상태 | 의미 |
|---|---|
| `queued` | 실행 대기 |
| `running` | 실행 중 |
| `waiting_input` | 질문·권한·계획·캔버스 입력 대기. `pendingRequests` 확인 |
| `succeeded` | 실행 완료. `result.text`와 `result.summary`에서 응답 확인 |
| `failed` | 실패 또는 제한 시간 초과. `error` 및 대화의 부분 결과 확인 |
| `cancelled` | 취소됨 |

Noah의 대화 목록에도 같은 대화가 표시됩니다. 실행 중인 대화를 열면 기존 스트리밍·질문 UI로 연결됩니다. 대기열에만 있는 작업의 사용자 메시지는 실제 실행 시작 시 기록됩니다. 외부 API의 `result`는 이 작업의 최종 응답이며 전체 대화 기록은 반환하지 않습니다. 백그라운드 작업이 남아 있으면 그것까지 종료되어야 최종 상태가 됩니다.

## 추가 질문·승인에 응답

`pendingRequests`의 각 항목은 `{ "event": "question", "data": { "requestId": "...", ... } }` 형태입니다. `data`에는 질문 내용 또는 승인 대상이 들어 있습니다.

```bash
curl "$NOAH_URL/api/v1/avatar/tasks/$TASK_ID/respond" \
  -H "Authorization: Bearer $NOAH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"requestId":"요청 ID","value":{"result":{"service":"A"}}}'
```

`value`는 해당 요청 종류의 응답 형식을 따릅니다.

- 질문: `{"result": ...}` 또는 `{"cancelled": true}`. 결과 구조는 `data.dialogKind`와 `data.payload`에 맞춥니다.
- 도구 권한: `{"behavior": "allow"}` 또는 `{"behavior": "deny"}`.
- 계획 승인: `{"behavior": "approved"}` 또는 `{"behavior": "rejected", "feedback": "수정 요청"}`.
- 캔버스: 해당 캔버스가 정의한 입력 형식. Noah 화면에서도 응답할 수 있습니다.

성공 시 `{"ok":true}`, 이미 응답했거나 만료된 요청은 **409**입니다. API로 보낸 지시도 기존 승인 정책을 따릅니다. 사용자 브라우저가 필요한 작업은 Noah 브라우저 연결이 있어야 합니다. API가 사용자 브라우저를 대신하지 않습니다.

## 취소·실행 한도·재시작

`POST /api/v1/avatar/tasks/:id/cancel`은 대기 작업을 취소하거나 실행 중인 작업에 중단을 요청합니다. 실행 중 취소는 비동기이므로 상태를 다시 조회하세요. 완료된 작업 취소는 **409**입니다.

- 사용자당 미완료 작업 최대 20개, 새 작업 접수 분당 최대 60개. 초과 시 **429**, `Retry-After: 60`.
- API 작업은 사용자당 한 개씩, 서버 전체 최대 4개 실행합니다. 같은 대화의 채팅이 실행 중이면 기다립니다. 공유 작업 저장소가 바쁘면 다음 디스패치에서 재시도합니다.
- 디스패처는 약 1초 간격으로 대기열을 확인합니다. 실행 시간은 `BOT_TASK_TIMEOUT_MINUTES` 설정을 사용하며 질문 대기 시간도 포함합니다.
- 대기 작업은 재시작 후 이어서 실행합니다. 실행 도중 재시작된 작업은 **failed**로 표시하고 자동 재실행하지 않습니다. 외부 변경이 일부 수행되었을 수 있으므로 대화를 확인하고 새 요청을 보내세요.
- 단일 Noah 프로세스·SQLite 배포 구조를 따릅니다. 별도 메시지 브로커는 필요하지 않습니다.

키 관리 API는 로그인 세션으로만 사용할 수 있습니다: `GET/POST /api/me/avatar-api-keys`, `DELETE /api/me/avatar-api-keys/:id`. 생성 본문은 `{"name":"연동 이름"}`입니다.
