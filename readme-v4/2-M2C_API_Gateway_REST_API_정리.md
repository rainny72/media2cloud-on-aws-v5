# Media2Cloud API Gateway REST API 정리

## API 개요

Media2Cloud은 Amazon API Gateway를 통해 RESTful API를 제공하여 전체 워크플로우를 프로그래밍 방식으로 제어할 수 있습니다.

**API 엔드포인트 형식**: `https://[API_ID].execute-api.[REGION].amazonaws.com/demo`

## 1. 자산 관리 API (Assets)

### 1.1 GET /demo/assets
**목적**: 자산 UUID 목록 조회

**파라미터**:
- `pageSize`: 페이지 크기 (기본값: 20)
- `type`: 자산 타입 필터 (`image|video|audio|document`)
- `overallStatus`: 상태 필터 (`COMPLETED|PROCESSING|ERROR`)
- `token`: 페이지네이션 토큰

**응답**:
```json
{
  "Items": [
    {
      "uuid": "[UUID]",
      "schemaVersion": 1,
      "type": "image",
      "timestamp": 1712450008235
    }
  ],
  "NextToken": "[TOKEN]"
}
```

### 1.2 GET /demo/assets/{uuid}
**목적**: 특정 자산의 수집 정보 조회

**응답**:
```json
{
  "overallStatus": "COMPLETED",
  "basename": "[FILENAME]",
  "bucket": "[INGEST_BUCKET]",
  "key": "[OBJECT_KEY]",
  "type": "image",
  "proxies": [...],
  "analysis": ["image"]
}
```

### 1.3 POST /demo/assets
**목적**: 수집 워크플로우 시작

**요청 본문**:
```json
{
  "input": {
    "uuid": "[UUID]",
    "bucket": "[INGEST_BUCKET]",
    "key": "[OBJECT_KEY]"
  }
}
```

**응답**:
```json
{
  "executionArn": "[MAIN_EXECUTION_ARN]",
  "startDate": "2024-04-10T22:37:58.905Z",
  "uuid": "[UUID]",
  "status": "STARTED"
}
```

### 1.4 DELETE /demo/assets/{uuid}
**목적**: 자산 삭제

**응답**:
```json
{
  "uuid": "[UUID]",
  "status": "REMOVED"
}
```

## 2. 분석 결과 API (Analysis)

### 2.1 GET /demo/analysis/{uuid}
**목적**: 자산의 분석 결과 조회

**응답**:
```json
[
  {
    "startTime": 1710950164758,
    "executionArn": "[ANALYSIS_VIDEO_EXECUTION_ARN]",
    "status": "COMPLETED",
    "uuid": "[UUID]",
    "rekognition": {
      "celeb": {...},
      "face": {...},
      "label": {...}
    },
    "type": "video"
  }
]
```

## 3. 검색 API (Search)

### 3.1 GET /demo/search
**목적**: 콘텐츠 검색

**파라미터**:
- `query`: 검색어 (Base64 인코딩 필요)
- `pageSize`: 페이지 크기 (기본값: 30)
- `token`: 페이지네이션 토큰
- `[media_type]`: 미디어 타입별 필터 (`video|audio|image|document`)

**응답**:
```json
{
  "term": "\"Andy Jassy\"",
  "totalHits": 3,
  "nextToken": 1,
  "elapsed": 49,
  "hits": [
    {
      "id": "[UUID]",
      "score": 7.0853496,
      "type": "video",
      "fields": {
        "text": {
          "highlights": ["Executive Producer <em>Andy</em> <em>Jassy</em>"],
          "hits": [...]
        }
      }
    }
  ]
}
```

## 4. 실행 상태 API (Execution)

### 4.1 GET /demo/execution
**목적**: Step Functions 실행 상태 조회

**파라미터**:
- `executionArn`: 실행 ARN

## 5. IoT 정책 연결 API (Attach Policy)

### 5.1 POST /demo/attach-policy
**목적**: IoT 정책을 사용자에게 연결

## 6. Amazon Rekognition 관리 API

### 6.1 GET /demo/rekognition/face-collections
**목적**: 얼굴 컬렉션 목록 조회

### 6.2 GET /demo/rekognition/face-collection
**목적**: 특정 얼굴 컬렉션 조회
**파라미터**:
- `collectionId`: 컬렉션 ID
- `maxResults`: 최대 결과 수

### 6.3 GET /demo/rekognition/faces
**목적**: 얼굴 목록 조회

### 6.4 GET /demo/rekognition/face
**목적**: 특정 얼굴 조회
**파라미터**:
- `collectionId`: 컬렉션 ID
- `faceId`: 얼굴 ID

### 6.5 GET /demo/rekognition/custom-label-models
**목적**: 커스텀 라벨 모델 목록 조회

## 7. Amazon Transcribe 관리 API

### 7.1 GET /demo/transcribe/custom-vocabularies
**목적**: 커스텀 어휘 목록 조회

### 7.2 GET /demo/transcribe/custom-language-models
**목적**: 커스텀 언어 모델 목록 조회

## 8. Amazon Comprehend 관리 API

### 8.1 GET /demo/comprehend/custom-entity-recognizers
**목적**: 커스텀 엔티티 인식기 목록 조회

## 9. 통계 API (Stats)

### 9.1 GET /demo/stats
**목적**: 시스템 통계 조회

## 10. 사용자 관리 API (Users)

### 10.1 GET /demo/users
**목적**: Cognito 사용자 목록 조회

## 11. 설정 관리 API (Settings)

### 11.1 GET /demo/settings/aioptions
**목적**: AI/ML 옵션 설정 조회

### 11.2 POST /demo/settings/aioptions
**목적**: AI/ML 옵션 설정 업데이트

### 11.3 DELETE /demo/settings/aioptions
**목적**: AI/ML 옵션 설정 삭제

## 12. 생성형 AI API (GenAI)

### 12.1 POST /demo/genai/tokenize
**목적**: 텍스트 토큰화

**요청 본문**:
```json
{
  "text": "분석할 텍스트"
}
```

### 12.2 POST /demo/genai/genre
**목적**: 장르 분석

### 12.3 POST /demo/genai/sentiment
**목적**: 감정 분석

### 12.4 POST /demo/genai/summarize
**목적**: 요약 생성

### 12.5 POST /demo/genai/taxonomy
**목적**: 분류 체계 분석

### 12.6 POST /demo/genai/theme
**목적**: 주제 분석

### 12.7 POST /demo/genai/tvratings
**목적**: TV 등급 분석

### 12.8 POST /demo/genai/custom
**목적**: 커스텀 생성형 AI 작업

**공통 요청 본문**:
```json
{
  "model": "anthropic.claude-3-haiku-20240307-v1:0",
  "prompt": "분석 프롬프트",
  "text_inputs": ["분석할 텍스트"]
}
```

## 13. 얼굴 인덱서 API (Face Indexer)

### 13.1 GET /demo/faceindexer
**목적**: 얼굴 인덱서 정보 조회

### 13.2 POST /demo/faceindexer
**목적**: 얼굴 인덱싱 작업 실행

## API 인증

모든 API는 AWS Signature Version 4를 사용한 인증이 필요합니다.

**cURL 예시**:
```bash
curl https://[API_ID].execute-api.us-east-1.amazonaws.com/demo/assets \
  --aws-sigv4 "aws:amz:us-east-1:execute-api" \
  --user "[AccessKeyId]:[SecretAccessKey]" \
  --get
```

## 지원되는 HTTP 메서드

- **GET**: 데이터 조회
- **POST**: 데이터 생성/작업 실행
- **DELETE**: 데이터 삭제
- **OPTIONS**: CORS 프리플라이트 요청

## 에러 처리

모든 API는 표준 HTTP 상태 코드를 반환하며, 에러 발생 시 JSON 형태의 에러 메시지를 제공합니다.

## 페이지네이션

목록 조회 API는 `token`과 `pageSize` 파라미터를 통한 페이지네이션을 지원합니다.