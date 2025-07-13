# Media2Cloud DB 종합 분석 문서

## 1. 개요

Media2Cloud은 DynamoDB와 OpenSearch를 활용한 하이브리드 데이터베이스 아키텍처를 사용합니다.

### 1.1 데이터베이스 구성
- **DynamoDB**: 구조화된 메타데이터 저장 (5개 테이블)
- **OpenSearch**: 전문 검색 및 분석 데이터 저장 (1개 인덱스)

### 1.2 핵심 클래스
- **DB 클래스**: DynamoDB 추상화 레이어
- **FaceIndexer 클래스**: 얼굴 인식 전용 DB 관리
- **Indexer 클래스**: OpenSearch 추상화 레이어

## 2. DynamoDB 구조

### 2.1 Environment.DynamoDB 정의
**위치**: `source/layers/core-lib/lib/environment.js`

```javascript
DynamoDB: {
  Ingest: {
    Table: `${ResourcePrefix}-ingest`,
    PartitionKey: 'uuid',
    GSI: {
      SchemaVersion: { Name: 'gsi-schemaversion-timestamp', Key: 'schemaVersion', Value: 1 },
      Type: { Name: 'gsi-type-timestamp', Key: 'type' },
      Group: { Name: 'gsi-group-timestamp', Key: 'group' },
      Status: { Name: 'gsi-overallstatus-timestamp', Key: 'overallStatus' },
      PageSize: 20,
    },
  },
  AIML: {
    Table: `${ResourcePrefix}-aiml`,
    PartitionKey: 'uuid',
    SortKey: 'type',
  },
  ServiceToken: {
    Table: `${ResourcePrefix}-service-token`,
    PartitionKey: 'uuid',
    SortKey: 'keyword',
  },
  FaceIndexer: {
    Table: `${ResourcePrefix}-faceindexer`,
    PartitionKey: 'faceId',
    GSI: {
      FaceId: { Name: 'gsi-faceid-timestamp', Key: 'faceId' },
      Celeb: { Name: 'gsi-celeb-timestamp', Key: 'celeb' },
    },
  },
  Shoppable: {
    Table: `${ResourcePrefix}-shoppable`,
    PartitionKey: 'uuid',
  },
}
```

### 2.2 테이블별 역할

#### 2.2.1 Ingest 테이블
- **목적**: 미디어 자산 메타데이터 및 처리 상태 관리
- **파티션 키**: uuid (자산 고유 식별자)
- **GSI 활용**:
  - `gsi-schemaversion-timestamp`: 전체 자산 조회
  - `gsi-type-timestamp`: 미디어 타입별 조회 (video, audio, image, document)
  - `gsi-group-timestamp`: 그룹별 조회
  - `gsi-overallstatus-timestamp`: 처리 상태별 조회 (PROCESSING, COMPLETED, ERROR)

#### 2.2.2 AIML 테이블
- **목적**: AI/ML 분석 결과 저장
- **파티션 키**: uuid, **정렬 키**: type
- **분석 타입**: rekognition, transcribe, comprehend, textract 등

#### 2.2.3 FaceIndexer 테이블
- **목적**: 얼굴 인식 및 태깅 정보 관리
- **파티션 키**: faceId
- **GSI 활용**:
  - `gsi-faceid-timestamp`: 얼굴 ID별 조회
  - `gsi-celeb-timestamp`: 셀럽별 조회

#### 2.2.4 ServiceToken 테이블
- **목적**: Step Functions 토큰 관리 (비동기 처리)
- **파티션 키**: uuid, **정렬 키**: keyword

#### 2.2.5 Shoppable 테이블
- **목적**: 쇼핑 관련 메타데이터 저장
- **파티션 키**: uuid

## 3. DB 클래스 분석

### 3.1 클래스 구조
**위치**: `source/layers/core-lib/lib/db.js`

```javascript
class DB {
  constructor(params) {
    this.$table = params.Table;
    this.$partitionKey = params.PartitionKey;
    this.$sortKey = params.SortKey;
  }
}
```

### 3.2 READ 메서드

#### 3.2.1 fetch() - 단일 레코드 조회
```javascript
async fetch(primaryValue, sortValue, projection)
```
- **용도**: 특정 UUID로 자산 정보 조회
- **특징**: 프로젝션 지원으로 필요한 필드만 선택 조회

#### 3.2.2 scanIndex() - GSI 스캔
```javascript
async scanIndex(data)
```
- **용도**: GSI를 활용한 필터링 조회
- **파라미터**:
  - `Name`: GSI 인덱스 이름
  - `Key`: GSI 파티션 키
  - `Value`: 검색 값
  - `Token`: 페이지네이션 토큰 (Base64 인코딩)
  - `PageSize`: 페이지 크기 (기본 20)
  - `Ascending`: 정렬 순서

#### 3.2.3 batchGet() - 배치 조회
```javascript
async batchGet(pKeys, fieldsToGet = [])
```
- **용도**: 최대 100개 아이템 동시 조회
- **최적화**: 배치 크기 제한 및 동시성 제어

#### 3.2.4 scan() - 전체 스캔
```javascript
async scan(filter)
```
- **용도**: 테이블 전체 스캔 (필터 적용 가능)
- **주의**: 대용량 테이블에서는 성능 이슈 가능

### 3.3 WRITE 메서드

#### 3.3.1 update() - 레코드 업데이트/생성
```javascript
async update(primaryValue, sortValue, attributes, merge = true)
```
- **특징**:
  - 기본적으로 기존 데이터와 병합 (merge=true)
  - 데이터 정제 및 검증 수행
  - 파티션/정렬 키는 자동 제외

#### 3.3.2 batchWrite() - 배치 쓰기
```javascript
async batchWrite(items = [])
```
- **제한**: 최대 25개 아이템 per 배치
- **동시성**: 최대 10개 배치 동시 실행
- **반환**: 처리된 아이템과 미처리 아이템 구분

#### 3.3.3 batchUpdate() - 배치 업데이트
```javascript
async batchUpdate(items)
```
- **특징**: UpdateItem을 개별적으로 실행 (BatchWriteItem은 완전 덮어쓰기)
- **동시성**: 최대 20개 요청 동시 실행

#### 3.3.4 조건부 배치 처리
```javascript
async batchUpdateWithConditions(items, conditions)
async batchDeleteWithConditions(keys, conditions)
```
- **용도**: 조건부 업데이트/삭제
- **에러 처리**: ConditionalCheckFailedException 자동 처리

#### 3.3.5 dropColumns() - 컬럼 삭제
```javascript
async dropColumns(primaryValue, sortValue, attributes)
```
- **용도**: 특정 필드 삭제 (재분석 시 사용)

#### 3.3.6 purge() - 레코드 삭제
```javascript
async purge(primaryValue, sortValue)
```
- **용도**: 전체 레코드 삭제

### 3.4 헬퍼 기능

#### 3.4.1 DDB Helper
**위치**: `source/layers/core-lib/lib/ddbHelper.js`

```javascript
const { marshalling, unmarshalling } = require('./ddbHelper');
```
- **marshalling**: JavaScript 객체 → DynamoDB 형식 변환
- **unmarshalling**: DynamoDB 형식 → JavaScript 객체 변환
- **지원 작업**: 모든 DynamoDB 작업 타입 지원

#### 3.4.2 성능 최적화
- **X-Ray 추적**: 모든 DynamoDB 호출 추적
- **재시도 전략**: 지수 백오프 재시도
- **커스텀 User-Agent**: 솔루션 식별

## 4. FaceIndexer 클래스 분석

### 4.1 클래스 구조
**위치**: `source/layers/core-lib/lib/faceIndexer/index.js`

```javascript
class FaceIndexer {
  constructor() {
    this.$metric = { facesIndexed: 0, apiCount: 0 };
    this.$itemsCached = {};
  }
}
```

### 4.2 주요 기능

#### 4.2.1 얼굴 인덱싱
```javascript
async indexFaces(collectionId, externalImageId, bytes, maxFaces = 20)
```
- **AWS Rekognition 연동**: IndexFaces API 호출
- **품질 필터**: HIGH 품질만 인덱싱
- **메트릭 추적**: API 호출 수 및 인덱싱된 얼굴 수

#### 4.2.2 얼굴 등록
```javascript
async registerFace(faceId, fields)
```
- **DB 저장**: FaceIndexer 테이블에 얼굴 정보 저장
- **타임스탬프**: 자동 타임스탬프 추가

#### 4.2.3 배치 조회
```javascript
async batchGet(faceIds, fieldsToGet = [])
```
- **캐싱**: 메모리 캐시 활용으로 중복 조회 방지
- **최적화**: 캐시된 데이터 우선 반환

#### 4.2.4 배치 업데이트
```javascript
async batchUpdate(items)
```
- **태깅/삭제**: 얼굴 태깅 및 삭제 처리
- **연관 업데이트**: 동일 인물의 다른 얼굴들도 자동 업데이트
- **Rekognition 동기화**: 컬렉션에서도 얼굴 삭제

#### 4.2.5 컬렉션 가져오기
```javascript
async importFaces(collectionId, token)
```
- **대용량 처리**: 페이지네이션 지원
- **임계값 관리**: 250개 이상 시 Step Functions 사용 권장

### 4.3 External Image ID 관리
```javascript
static createExternalImageId(uuid, timestamp)
static resolveExternalImageId(id, defaultTo = false)
```
- **형식**: `version:uuid:timestamp`
- **호환성**: 이전 버전과의 호환성 유지
- **인코딩**: 유니코드 이름의 헥스 인코딩 지원

## 5. OpenSearch 구조 (Indexer 클래스)

### 5.1 클래스 구조
**위치**: `source/layers/core-lib/lib/indexer/index.js`

```javascript
class Indexer {
  constructor(node = DOMAIN_ENDPOINT, useOpenSearchServerless = USE_OPENSEARCH_SERVERLESS) {
    this.$client = new Client({ /* OpenSearch 클라이언트 설정 */ });
    this.$useOpenSearchServerless = useOpenSearchServerless;
  }
}
```

### 5.2 인덱스 구조

#### 5.2.1 Content 인덱스
- **이름**: `content`
- **용도**: 모든 미디어 자산의 검색 가능한 메타데이터 저장
- **매핑**: `source/layers/core-lib/lib/indexer/mappings/content.js`

#### 5.2.2 필드 분류
```javascript
// AI/ML 분석 결과 필드
const AIML_FIELDS = ['rekognition', 'transcribe', 'comprehend', 'textract', ...];

// 수집 메타데이터 필드  
const INGEST_FIELDS = ['uuid', 'basename', 'type', 'fileSize', 'duration', ...];
```

### 5.3 주요 기능

#### 5.3.1 인덱스 관리
```javascript
async createIndex(name, mapping = undefined)
async deleteIndex(name)
async batchCreateIndices(indices = INDICES)
async batchDeleteIndices(indices = INDICES)
```

#### 5.3.2 문서 관리
```javascript
async indexDocument(name, id, doc, forceWait = true)
async updateDocument(name, id, doc)
async deleteDocument(name, id)
async getDocument(name, id, fields = [])
```

#### 5.3.3 검색 기능
```javascript
async search(query)
async searchDocument(params)
async aggregate(fields, size = DEFAULT_AGGREGATION_SIZE)
async msearch(query)  // 다중 검색
async mget(query)     // 다중 문서 조회
```

#### 5.3.4 필드 관리
```javascript
async dropFields(name, id, fields = [])
async dropAnalysisFields(name, id)  // AI/ML 필드 일괄 삭제
```

### 5.4 OpenSearch Serverless 지원
- **인증**: AWS Signature V4 인증
- **제한사항**: refresh 플래그 미지원
- **대기 로직**: 문서 인덱싱 후 검색 가능할 때까지 대기

## 6. 실제 사용 패턴

### 6.1 자산 조회 (AssetOp)
```javascript
// 단일 자산 조회
const db = new DB({
  Table: Environment.DynamoDB.Ingest.Table,
  PartitionKey: Environment.DynamoDB.Ingest.PartitionKey,
});
const asset = await db.fetch(uuid);

// 상태별 자산 조회 (GSI 활용)
const assets = await db.scanIndex({
  Name: Environment.DynamoDB.Ingest.GSI.Status.Name,
  Key: Environment.DynamoDB.Ingest.GSI.Status.Key,
  Value: 'COMPLETED',
  PageSize: 20,
  Ascending: false,
});
```

### 6.2 분석 결과 관리 (AnalysisOp)
```javascript
// 분석 결과 조회
const db = new DB({
  Table: Environment.DynamoDB.AIML.Table,
  PartitionKey: Environment.DynamoDB.AIML.PartitionKey,
  SortKey: Environment.DynamoDB.AIML.SortKey,
});
const analysis = await db.fetch(uuid, 'rekognition');

// 분석 필드 삭제 (재분석 준비)
await db.dropColumns(uuid, undefined, 'analysis');
```

### 6.3 얼굴 관리 (FaceIndexerOp)
```javascript
// 얼굴 배치 조회
const faceIndexer = new FaceIndexer();
const faces = await faceIndexer.batchGet(faceIds);

// 얼굴 태깅 배치 업데이트
const updateItems = [
  { action: 'tagging', faceId: 'face1', celeb: 'John Doe' },
  { action: 'deleting', faceId: 'face2' }
];
await faceIndexer.batchUpdate(updateItems);
```

### 6.4 검색 (SearchOp)
```javascript
// OpenSearch 검색
const indexer = new Indexer();
const results = await indexer.search({
  index: 'content',
  body: {
    query: {
      query_string: {
        query: 'searchTerm',
        default_operator: 'AND'
      }
    },
    highlight: {
      fields: { '*': {} }
    }
  }
});
```

## 7. 성능 최적화 전략

### 7.1 DynamoDB 최적화
- **GSI 활용**: 다양한 쿼리 패턴 지원
- **배치 처리**: 최대 처리량 활용
- **페이지네이션**: Base64 토큰 기반
- **조건부 처리**: 불필요한 업데이트 방지

### 7.2 OpenSearch 최적화
- **인덱스 설계**: 단일 content 인덱스로 통합
- **필드 매핑**: 검색 최적화된 매핑
- **집계 쿼리**: 통계 및 분석 지원
- **하이라이트**: 검색 결과 강조

### 7.3 캐싱 전략
- **FaceIndexer 캐싱**: 메모리 기반 얼굴 정보 캐싱
- **중복 조회 방지**: 동일 요청 내 중복 제거

### 7.4 에러 처리
- **재시도 로직**: 지수 백오프 재시도
- **조건부 실패**: ConditionalCheckFailedException 처리
- **부분 실패**: 배치 처리 시 부분 성공 지원

## 8. 모니터링 및 추적

### 8.1 X-Ray 추적
- **모든 AWS SDK 호출 추적**
- **성능 병목 지점 식별**
- **에러 추적 및 분석**

### 8.2 메트릭 수집
- **FaceIndexer 메트릭**: API 호출 수, 인덱싱된 얼굴 수
- **배치 처리 메트릭**: 처리/미처리 아이템 수
- **검색 성능 메트릭**: 응답 시간, 결과 수

### 8.3 로깅
- **구조화된 로깅**: JSON 형태의 로그
- **에러 상세 정보**: 스택 트레이스 및 컨텍스트
- **성능 로그**: 처리 시간 및 리소스 사용량

이 종합적인 DB 구조를 통해 Media2Cloud은 대용량 미디어 처리 워크플로우를 효율적으로 지원하며, 확장 가능하고 성능 최적화된 데이터 관리를 제공합니다.