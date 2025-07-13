# Media2Cloud v5 API Gateway REST API 정의 및 Operation 설명

## 1. API Gateway 개요

Media2Cloud v5는 Amazon API Gateway를 통해 RESTful API를 제공하며, 웹 애플리케이션과 백엔드 서비스 간의 통신을 담당합니다.

### 1.1 API 기본 정보
- **API 타입**: REST API
- **인증 방식**: Amazon Cognito User Pool
- **지역**: Regional API
- **CORS**: 활성화됨
- **스테이지**: prod (기본)

### 1.2 API 엔드포인트 구조
```
https://{api-id}.execute-api.{region}.amazonaws.com/prod/{operation}/{sub-operation}
```

## 2. API 인증 및 권한

### 2.1 Cognito 통합
```javascript
// 인증 헤더 예시
Authorization: Bearer {JWT_TOKEN}
```

### 2.2 사용자 그룹별 권한
- **Admin**: 모든 API 접근 가능
- **Creator**: 업로드, 분석, 검색 가능
- **Viewer**: 검색 및 조회만 가능

## 3. 주요 API Operations

### 3.1 Assets Operation (`/assets`)

#### 3.1.1 GET /assets
**목적**: 미디어 자산 목록 조회

**요청 파라미터**:
```json
{
  "queryStringParameters": {
    "pageSize": "20",
    "token": "next-page-token",
    "type": "video|audio|image|document"
  }
}
```

**응답 예시**:
```json
{
  "assets": [
    {
      "uuid": "12345678-1234-1234-1234-123456789012",
      "bucket": "ingest-bucket",
      "key": "video/sample.mp4",
      "type": "video",
      "timestamp": "2024-01-01T00:00:00Z",
      "fileSize": 1048576,
      "duration": 120.5
    }
  ],
  "nextToken": "next-page-token"
}
```

#### 3.1.2 POST /assets
**목적**: 새로운 미디어 자산 업로드 시작

**요청 본문**:
```json
{
  "input": {
    "bucket": "ingest-bucket",
    "key": "video/new-video.mp4",
    "aiOptions": {
      "celeb": true,
      "face": true,
      "label": true,
      "transcribe": true
    }
  }
}
```

#### 3.1.3 DELETE /assets/{uuid}
**목적**: 미디어 자산 삭제

**경로 파라미터**:
- `uuid`: 삭제할 자산의 UUID

### 3.2 Analysis Operation (`/analysis`)

#### 3.2.1 GET /analysis/{uuid}
**목적**: 특정 자산의 분석 결과 조회

**응답 예시**:
```json
{
  "uuid": "12345678-1234-1234-1234-123456789012",
  "status": "COMPLETED",
  "results": {
    "rekognition": {
      "celeb": [...],
      "face": [...],
      "label": [...]
    },
    "transcribe": {
      "transcript": "...",
      "segments": [...]
    }
  }
}
```

#### 3.2.2 POST /analysis/{uuid}
**목적**: 추가 분석 작업 시작

**요청 본문**:
```json
{
  "aiOptions": {
    "sentiment": true,
    "entity": true
  }
}
```

### 3.3 Search Operation (`/search`)

#### 3.3.1 GET /search
**목적**: 메타데이터 검색

**쿼리 파라미터**:
```json
{
  "q": "검색어",
  "type": "video|audio|image|document",
  "from": "2024-01-01",
  "to": "2024-12-31",
  "size": "20",
  "from": "0"
}
```

**응답 예시**:
```json
{
  "total": 150,
  "hits": [
    {
      "uuid": "...",
      "score": 0.95,
      "source": {
        "bucket": "...",
        "key": "...",
        "metadata": {...}
      }
    }
  ]
}
```

#### 3.3.2 POST /search
**목적**: 고급 검색 (복합 조건)

**요청 본문**:
```json
{
  "query": {
    "bool": {
      "must": [
        {"match": {"transcript": "keyword"}},
        {"range": {"timestamp": {"gte": "2024-01-01"}}}
      ]
    }
  },
  "size": 20,
  "from": 0
}
```

### 3.4 Execution Operation (`/execution`)

#### 3.4.1 GET /execution/{executionArn}
**목적**: Step Functions 실행 상태 조회

**응답 예시**:
```json
{
  "executionArn": "arn:aws:states:...",
  "status": "RUNNING|SUCCEEDED|FAILED",
  "startDate": "2024-01-01T00:00:00Z",
  "input": {...},
  "output": {...}
}
```

#### 3.4.2 DELETE /execution/{executionArn}
**목적**: 실행 중인 워크플로우 중단

### 3.5 IoT Operation (`/attach-iot-policy`)

#### 3.5.1 POST /attach-iot-policy
**목적**: IoT 정책 연결 (실시간 상태 업데이트용)

**요청 본문**:
```json
{
  "principal": "cognito-identity-id"
}
```

### 3.6 Rekognition Operation (`/rekognition`)

#### 3.6.1 GET /rekognition/collections
**목적**: Rekognition 컬렉션 목록 조회

#### 3.6.2 POST /rekognition/collections
**목적**: 새 컬렉션 생성

#### 3.6.3 GET /rekognition/collections/{collectionId}/faces
**목적**: 컬렉션 내 얼굴 목록 조회

### 3.7 Settings Operation (`/settings`)

#### 3.7.1 GET /settings/aioptions
**목적**: AI/ML 옵션 설정 조회

**응답 예시**:
```json
{
  "minConfidence": 80,
  "enabledFeatures": [
    "celeb",
    "face",
    "label",
    "transcribe"
  ],
  "customSettings": {...}
}
```

#### 3.7.2 POST /settings/aioptions
**목적**: AI/ML 옵션 설정 업데이트

### 3.8 GenAI Operation (`/genai`)

#### 3.8.1 POST /genai/summarize
**목적**: AI 기반 콘텐츠 요약

**요청 본문**:
```json
{
  "uuid": "asset-uuid",
  "type": "transcript|metadata",
  "model": "claude-3-sonnet"
}
```

#### 3.8.2 POST /genai/chat
**목적**: 대화형 AI 질의응답

**요청 본문**:
```json
{
  "uuid": "asset-uuid",
  "question": "이 비디오의 주요 내용은 무엇인가요?",
  "context": "previous-conversation"
}
```

### 3.9 Stats Operation (`/stats`)

#### 3.9.1 GET /stats/dashboard
**목적**: 대시보드 통계 정보 조회

**응답 예시**:
```json
{
  "totalAssets": 1500,
  "processingJobs": 5,
  "completedToday": 25,
  "storageUsed": "1.2TB",
  "topCategories": [...]
}
```

### 3.10 Users Operation (`/users`)

#### 3.10.1 GET /users/profile
**목적**: 사용자 프로필 조회

#### 3.10.2 PUT /users/profile
**목적**: 사용자 프로필 업데이트

## 4. API 응답 형식

### 4.1 성공 응답
```json
{
  "statusCode": 200,
  "headers": {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  "body": {
    "data": {...},
    "message": "Success"
  }
}
```

### 4.2 오류 응답
```json
{
  "statusCode": 400|401|403|404|500,
  "headers": {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  "body": {
    "error": "Error message",
    "code": "ERROR_CODE",
    "details": {...}
  }
}
```

## 5. API 사용 예시

### 5.1 JavaScript/Node.js
```javascript
const response = await fetch(`${API_ENDPOINT}/assets`, {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
```

### 5.2 Python
```python
import requests

headers = {
    'Authorization': f'Bearer {jwt_token}',
    'Content-Type': 'application/json'
}

response = requests.get(f'{API_ENDPOINT}/assets', headers=headers)
data = response.json()
```

### 5.3 cURL
```bash
curl -X GET \
  "${API_ENDPOINT}/assets" \
  -H "Authorization: Bearer ${JWT_TOKEN}" \
  -H "Content-Type: application/json"
```

## 6. API 제한 및 할당량

### 6.1 Rate Limiting
- **기본 제한**: 1000 requests/second
- **버스트 제한**: 2000 requests
- **사용자별 제한**: 100 requests/minute

### 6.2 페이지네이션
- **기본 페이지 크기**: 20개 항목
- **최대 페이지 크기**: 100개 항목
- **토큰 기반 페이지네이션** 사용

## 7. API 보안

### 7.1 HTTPS 강제
- 모든 API 호출은 HTTPS 필수
- TLS 1.2 이상 지원

### 7.2 CORS 설정
```json
{
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
}
```

### 7.3 입력 검증
- JSON 스키마 검증
- SQL 인젝션 방지
- XSS 방지

## 8. API 모니터링

### 8.1 CloudWatch 메트릭
- API 호출 수
- 응답 시간
- 오류율
- 스로틀링 발생

### 8.2 X-Ray 추적
- 요청 추적
- 성능 분석
- 병목 지점 식별

## 9. API 버전 관리

### 9.1 버전 전략
- URL 경로 기반 버전 관리
- 하위 호환성 유지
- 점진적 마이그레이션 지원

### 9.2 Deprecation 정책
- 6개월 사전 공지
- 마이그레이션 가이드 제공
- 레거시 버전 지원 기간