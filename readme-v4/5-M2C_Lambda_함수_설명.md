# Media2Cloud API Lambda 코드 정리 및 사용 가이드

## 1. API Lambda 아키텍처 개요

Media2Cloud의 API Lambda는 Amazon API Gateway를 통해 RESTful API를 제공하는 단일 Lambda 함수입니다. 이 함수는 다양한 Operation 클래스를 통해 요청을 처리합니다.

### 1.1 핵심 구조
```
source/api/
├── index.js                    # Lambda 진입점
├── lib/
│   ├── apiRequest.js          # 요청 라우팅 및 처리
│   └── operations/            # 각 API 기능별 구현
│       ├── baseOp.js          # 기본 Operation 클래스
│       ├── assetOp.js         # 자산 관리
│       ├── analysisOp.js      # 분석 결과 관리
│       ├── searchOp.js        # 검색 기능
│       ├── genaiOp.js         # 생성형 AI
│       ├── faceIndexerOp.js   # 얼굴 인덱서
│       └── ...
```

## 2. 핵심 컴포넌트 분석

### 2.1 Lambda 진입점 (index.js)

```javascript
exports.handler = async (event, context) => {
  const request = new ApiRequest(event, context);
  const processor = request.getProcessor();
  
  switch (request.method) {
    case 'GET': return processor.onGET();
    case 'POST': return processor.onPOST();
    case 'DELETE': return processor.onDELETE();
    case 'OPTIONS': return processor.onOPTIONS();
  }
};
```

**특징**:
- 단일 Lambda 함수로 모든 API 요청 처리
- HTTP 메서드별 라우팅
- 환경 변수 검증 및 에러 처리

### 2.2 요청 라우터 (ApiRequest)

```javascript
class ApiRequest {
  getProcessor() {
    const op = this.pathParameters.operation;
    
    if (op === 'assets') return new AssetOp(this);
    if (op === 'analysis') return new AnalysisOp(this);
    if (op === 'search') return new SearchOp(this);
    if (op === 'genai') return new GenAIOp(this);
    // ...
  }
}
```

**기능**:
- URL 경로 기반 Operation 클래스 선택
- Cognito Identity ID 검증
- 요청 본문 JSON 파싱

### 2.3 기본 Operation 클래스 (BaseOp)

```javascript
class BaseOp {
  getCors(data) {
    return {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,GET,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,...'
    };
  }
  
  onSucceed(payload) {
    return {
      statusCode: 200,
      headers: this.getCors(payload),
      body: JSON.stringify(payload)
    };
  }
  
  onError(e) {
    return {
      statusCode: 200,
      headers: this.getCors(),
      body: JSON.stringify({
        errorCode: 500,
        errorMessage: e.message
      })
    };
  }
}
```

**특징**:
- CORS 헤더 자동 설정
- 표준화된 응답 형식
- 에러 처리 통합

## 3. 주요 Operation 클래스 분석

### 3.1 AssetOp (자산 관리)

#### GET 요청 처리
```javascript
async onGET() {
  const uuid = this.request.pathParameters.uuid;
  
  if (uuid) {
    // 특정 자산 조회
    return this.onGetByUuid(uuid);
  }
  
  const { overallStatus, type, pageSize, token } = this.request.queryString;
  
  if (overallStatus) {
    // 상태별 자산 조회
    return this.onGetByOverallStatus(overallStatus, token, pageSize);
  }
  
  if (type) {
    // 타입별 자산 조회
    return this.onGetByType(type, token, pageSize);
  }
  
  // 전체 자산 조회
  return this.onGetAll(token, pageSize);
}
```

#### POST 요청 처리 (워크플로우 시작)
```javascript
async onPOST() {
  const { input } = this.request.body;
  
  // 입력 검증
  if (!input.uuid && !(input.bucket && input.key)) {
    throw new M2CException('uuid or bucket and key must be specified');
  }
  
  // JSON 파일인 경우 배치 처리
  if (JsonProvider.isJsonFile(input.key)) {
    return this.batchStartIngestWorkflow(params);
  }
  
  // 단일 파일 처리
  return this.startIngestWorkflow(params);
}
```

**주요 기능**:
- 자산 목록 조회 (페이지네이션 지원)
- 특정 자산 상세 정보 조회
- 수집 워크플로우 시작
- 자산 삭제 (제거 워크플로우 시작)

### 3.2 AnalysisOp (분석 결과 관리)

#### 분석 결과 조회
```javascript
async onGET() {
  const uuid = this.request.pathParameters.uuid;
  
  // 분석 타입 확인
  const types = await this.getAnalysisTypes(uuid);
  
  // 각 타입별 분석 결과 조회
  const responses = await Promise.all(
    types.analysis.map(type => this.fetchAnalysisResult(uuid, type))
  );
  
  return responses.filter(response => response !== undefined);
}
```

#### 재분석 시작
```javascript
async onPOST() {
  const { input } = this.request.body;
  const uuid = input.uuid;
  
  // 기존 설정 조회
  const original = await this.getOriginalSettings(uuid);
  
  // 수집 워크플로우 재실행 필요 여부 판단
  const ingestRequired = this.enableIngest(original.aiOptions, input.aiOptions);
  
  // 적절한 상태 머신 선택
  const stateMachine = ingestRequired ? 'Main' : 'Analysis';
  
  return this.startWorkflow(stateMachine, params);
}
```

**주요 기능**:
- 분석 결과 조회 (비디오, 오디오, 이미지, 문서)
- AI/ML 옵션 변경 후 재분석
- 분석 결과 삭제

### 3.3 SearchOp (검색 기능)

#### 복합 검색 처리
```javascript
async compoundSearch(qs) {
  const query = this.santizeQuerystring(qs.query);
  const types = ['audio', 'video', 'image', 'document']
    .filter(x => qs[x] !== 'false');
  
  // OpenSearch 쿼리 구성
  const searchParams = this.buildCompoundQuery(id, types, query, from, size);
  
  // 검색 실행
  const results = await indexer.search(searchParams);
  
  // 상세 정보 조회
  const hits = await this.parseSearchResults(results.hits);
  
  return { ...results, hits };
}
```

**특징**:
- Base64 인코딩된 검색어 지원
- AND, OR, NOT 연산자 지원
- 미디어 타입별 필터링
- 하이라이트 기능

### 3.4 GenAIOp (생성형 AI)

#### 생성형 AI 요청 처리
```javascript
async onPOST() {
  const op = this.request.pathParameters.uuid;
  
  // 토큰화 특별 처리
  if (op === 'tokenize') {
    return this.onTokenize();
  }
  
  const { model, prompt, text_inputs } = this.request.body;
  
  // 입력 검증
  if (!model || !prompt || !text_inputs) {
    throw new M2CException('Required parameters missing');
  }
  
  // 모델 선택 및 추론 실행
  const modelInstance = new Claude();
  const response = await modelInstance.inference(op, params);
  
  return response;
}
```

**지원 기능**:
- 텍스트 토큰화
- 장르 분석
- 감정 분석
- 요약 생성
- 분류 체계 분석
- 주제 분석
- TV 등급 분석
- 커스텀 작업

### 3.5 FaceIndexerOp (얼굴 인덱서)

#### 얼굴 조회
```javascript
async onGetFacesByCollection() {
  const { collectionId, token, pageSize } = this.request.queryString;
  
  // Rekognition에서 얼굴 목록 조회
  const faces = await this.listFacesFromRekognition(collectionId, token, pageSize);
  
  // FaceIndexer 테이블에서 상세 정보 조회
  const faceIndexer = new FaceIndexer();
  const details = await faceIndexer.batchGet(faceIds);
  
  return this.mergeFaceData(faces, details);
}
```

#### 얼굴 태깅 업데이트
```javascript
async onUpdateFaceTaggings() {
  const items = this.request.body;
  const faceIndexer = new FaceIndexer();
  
  // 배치 업데이트 실행
  const response = await faceIndexer.batchUpdate(items);
  
  // 변경사항이 있으면 업데이트 워크플로우 시작
  if (response.deleted.length + response.updated.length > 0) {
    await this.startUpdateJob(response);
  }
  
  return response;
}
```

**주요 기능**:
- 얼굴 컬렉션별 조회
- 얼굴 인덱싱
- 얼굴 태깅 업데이트
- 얼굴 삭제
- 얼굴 가져오기

## 4. API 사용 가이드

### 4.1 인증 설정

#### IAM 사용자 생성
```bash
# API 사용자 생성
aws iam create-user --user-name Media2CloudApiUser

# 정책 연결
aws iam attach-user-policy \
  --policy-arn arn:aws:iam::aws:policy/AmazonAPIGatewayInvokeFullAccess \
  --user-name Media2CloudApiUser

# 액세스 키 생성
aws iam create-access-key --user-name Media2CloudApiUser
```

#### 최소 권한 정책 예시
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::ingest-bucket/*",
        "arn:aws:s3:::proxy-bucket/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "execute-api:Invoke",
      "Resource": "arn:aws:execute-api:region:account:api-id/demo/*/*"
    }
  ]
}
```

### 4.2 API 엔드포인트 확인

```bash
# CloudFormation 스택에서 API 엔드포인트 조회
aws cloudformation describe-stacks \
  --stack-name media2cloudv4 | \
  jq '.Stacks[0].Outputs[] | select(.OutputKey == "ApiEndpoint")'
```

### 4.3 주요 API 사용 예시

#### 자산 목록 조회
```bash
curl "https://api-id.execute-api.region.amazonaws.com/demo/assets" \
  --aws-sigv4 "aws:amz:region:execute-api" \
  --user "ACCESS_KEY:SECRET_KEY" \
  --get
```

#### 워크플로우 시작
```bash
curl -X POST \
  "https://api-id.execute-api.region.amazonaws.com/demo/assets" \
  --aws-sigv4 "aws:amz:region:execute-api" \
  --user "ACCESS_KEY:SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "bucket": "ingest-bucket",
      "key": "video/sample.mp4"
    }
  }'
```

#### 검색 실행
```bash
# 검색어를 Base64로 인코딩
QUERY=$(echo "Andy Jassy" | base64)

curl "https://api-id.execute-api.region.amazonaws.com/demo/search" \
  --aws-sigv4 "aws:amz:region:execute-api" \
  --user "ACCESS_KEY:SECRET_KEY" \
  --get \
  --data-urlencode "query=$QUERY" \
  --data-urlencode "pageSize=10"
```

#### 생성형 AI 사용
```bash
curl -X POST \
  "https://api-id.execute-api.region.amazonaws.com/demo/genai/summarize" \
  --aws-sigv4 "aws:amz:region:execute-api" \
  --user "ACCESS_KEY:SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic.claude-3-haiku-20240307-v1:0",
    "prompt": "Summarize the following text:",
    "text_inputs": ["Long text to summarize..."]
  }'
```

## 5. 에러 처리 및 모니터링

### 5.1 표준 에러 응답
```json
{
  "errorCode": 500,
  "errorName": "M2CException",
  "errorMessage": "GET /demo/assets - invalid uuid"
}
```

### 5.2 로깅 및 추적
- **CloudWatch Logs**: 모든 요청/응답 로깅
- **X-Ray**: 분산 추적 지원
- **Custom Metrics**: 솔루션별 메트릭 수집

### 5.3 성능 최적화
- **Connection Pooling**: AWS SDK 연결 재사용
- **Retry Strategy**: 지수 백오프 재시도
- **Caching**: DynamoDB 결과 캐싱

## 6. 확장 및 커스터마이징

### 6.1 새로운 Operation 추가
1. `operations/` 폴더에 새 클래스 생성
2. `BaseOp` 클래스 상속
3. `apiRequest.js`에 라우팅 추가
4. 필요한 권한을 IAM 정책에 추가

### 6.2 미들웨어 패턴
```javascript
class CustomOp extends BaseOp {
  async onGET() {
    // 전처리
    await this.preProcess();
    
    // 메인 로직
    const result = await this.processRequest();
    
    // 후처리
    await this.postProcess(result);
    
    return super.onGET(result);
  }
}
```

이 가이드를 통해 Media2Cloud API Lambda의 구조를 이해하고 효과적으로 활용할 수 있습니다.