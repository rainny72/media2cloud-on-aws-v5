# Media2Cloud Contents Ingestion Pipeline 구성 및 관련 코드 정리

## 1. Ingestion Pipeline 개요

Media2Cloud의 Contents Ingestion Pipeline은 다양한 미디어 파일(비디오, 오디오, 이미지, 문서)을 AWS 환경으로 수집하고 처리하는 서버리스 워크플로우입니다.

### 주요 구성 요소
- **Main State Machine**: 전체 워크플로우의 진입점
- **Ingestion Main State Machine**: 미디어 타입별 수집 워크플로우 조율
- **미디어별 Ingest State Machine**: 각 미디어 타입에 특화된 처리 로직

## 2. Pipeline 아키텍처

```
Main State Machine
├── Start Ingest State Machine
│   ├── Create Record
│   ├── Start Fixity
│   ├── Fixity Completed
│   ├── Choose by Media Type
│   │   ├── Start Image Ingest
│   │   ├── Start Video Ingest
│   │   ├── Start Audio Ingest
│   │   └── Start Document Ingest
│   ├── Update Record
│   ├── Index Ingest Results
│   └── Completed
└── Start Analysis State Machine
```

## 3. 핵심 워크플로우

### 3.1 Main State Machine
**위치**: `source/main/README.md`

- **역할**: 백엔드 워크플로우의 진입점
- **기능**: AWS Step Functions Nested Workflows를 사용하여 수집 및 분석 워크플로우 조율

**최소 입력 파라미터**:
```json
{
  "input": {
    "uuid": "UUID",
    "bucket": "INGEST_BUCKET",
    "key": "S3_OBJECT_KEY"
  }
}
```

### 3.2 Ingestion Main State Machine
**위치**: `source/main/ingest/main/README.md`

#### 주요 상태들:
1. **Create Record**: DynamoDB에 레코드 생성
2. **Start Fixity**: 파일 무결성 검사 수행
3. **Fixity Completed**: 무결성 검사 완료 처리
4. **Choose by Media Type**: 미디어 타입별 분기
5. **Update Record**: 처리 상태 업데이트
6. **Index Ingest Results**: OpenSearch 클러스터에 인덱싱
7. **Completed**: 수집 워크플로우 완료

## 4. 미디어별 Ingest State Machine

### 4.1 Video Ingest State Machine
**위치**: `source/main/ingest/video/README.md`

#### 주요 기능:
- **MediaInfo 추출**: 비디오 기술 메타데이터 추출
- **AWS Elemental MediaConvert**: 프록시 파일 생성
  - MP4 비디오 프록시 (Video Analysis용)
  - M4A 오디오 프록시 (Audio Analysis용)
  - 프레임 캡처 이미지 (Frame Based Analysis용)
- **Perceptual Hash 계산**: 동적 프레임 분석을 위한 해시값 계산

#### 생성되는 출력물:
```
s3://[PROXY_BUCKET]/[UUID]/
├── mediainfo/mediainfo.json
├── transcode/aiml/[FILENAME].mp4
├── transcode/aiml/[FILENAME].m4a
├── transcode/frameCapture/frame.XXXXXXX.jpg
└── transcode/frameCapture/frameHashes.json
```

### 4.2 Image Ingest State Machine
**위치**: `source/main/ingest/image/README.md`

#### 주요 기능:
- **ExifTool**: EXIF 정보 추출
- **Jimp**: JPEG 형식 프록시 이미지 생성

### 4.3 Audio Ingest State Machine
**위치**: `source/main/ingest/audio/`

#### 주요 기능:
- MediaInfo를 사용한 오디오 메타데이터 추출
- AWS Elemental MediaConvert를 통한 오디오 트랜스코딩

### 4.4 Document Ingest State Machine
**위치**: `source/main/ingest/document/`

#### 주요 기능:
- PDF 문서 정보 추출
- 문서 메타데이터 처리

## 5. 핵심 코드 구조

### 5.1 Create Record 구현
**파일**: `source/main/ingest/main/states/create-record/index.js`

```javascript
class StateCreateRecord {
  async process() {
    // UUID, bucket, key 검증
    // S3 객체 메타데이터 조회
    // MIME 타입 결정
    // MD5 체크섬 찾기
    // Frame Capture Mode 파싱
    // DynamoDB 레코드 생성
  }

  async findMd5(data) {
    // 1. x-amz-metadata-md5 확인
    // 2. 객체 태깅에서 computed-md5 확인
    // 3. ETag에서 MD5 추출 (단일 파트 업로드인 경우)
  }
}
```

### 5.2 Video Transcode 구현
**파일**: `source/main/ingest/video/states/start-transcode/index.js`

```javascript
class StateStartTranscode {
  async createJobTemplate() {
    // 오디오 채널 매핑 생성
    // 출력 그룹 생성 (AIML, Proxy, FrameCapture)
    // 입력 크롭 필터 적용
    // MediaConvert 작업 템플릿 구성
  }

  async useFrameCapture() {
    // 프레임 캡처 모드에 따른 프레임 레이트 계산
    // 프레임 캡처 출력 그룹 생성
  }
}
```

## 6. Service Backlog Management System

대량의 동시 요청을 처리하기 위해 Service Backlog Management System을 사용:

- **위치**: `source/layers/service-backlog-lib/`
- **기능**: MediaConvert 작업 요청을 큐잉하고 처리
- **장점**: 동시성 제한 없이 대규모 미디어 처리 가능

## 7. AI/ML 옵션 설정

### 7.1 AI 옵션 우선순위
1. Main State Machine 시작 시 입력 파라미터
2. 웹 포털 설정 페이지의 전역 설정
3. CloudFormation 스택 생성 시 기본 설정

### 7.2 주요 AI 옵션 카테고리
- **Visual Analysis**: 유명인 인식, 얼굴 인식, 라벨 감지 등
- **Audio Analysis**: 음성-텍스트 변환, 언어 코드 지정 등
- **NLP Analysis**: 핵심 구문, 엔티티, 감정 분석 등
- **Document Analysis**: Amazon Textract 문서 분석
- **Advanced Features**: 프레임 기반 분석, 자동 얼굴 인덱서, 장면 감지 등

## 8. 데이터 저장 및 관리

### 8.1 DynamoDB 테이블
- **Ingest Table**: 수집 상태 및 메타데이터 저장
- **Service Token Table**: 백로그 작업 토큰 관리

### 8.2 S3 버킷 구조
```
INGEST_BUCKET/          # 원본 미디어 파일
PROXY_BUCKET/           # 프록시 파일 및 메타데이터
├── [UUID]/
│   ├── mediainfo/
│   ├── transcode/
│   └── analysis/
```

### 8.3 OpenSearch 인덱싱
- 수집 결과를 OpenSearch 클러스터에 인덱싱
- 검색 및 조회 기능 제공

## 9. 에러 처리 및 모니터링

### 9.1 IAM 권한
각 Lambda 함수는 최소 권한 원칙에 따라 필요한 AWS 서비스에만 접근:
- S3 버킷 읽기/쓰기
- DynamoDB 테이블 조작
- MediaConvert 작업 생성
- OpenSearch 인덱싱
- SNS 알림 발송

### 9.2 X-Ray 추적
- 모든 Lambda 함수에서 X-Ray 추적 활성화
- AWS 서비스 간 통신 모니터링

## 10. 확장성 및 성능

### 10.1 서버리스 아키텍처
- AWS Lambda를 통한 자동 스케일링
- Step Functions를 통한 워크플로우 조율
- 이벤트 기반 처리

### 10.2 동시성 관리
- Service Backlog System을 통한 큐잉
- MediaConvert 작업 분산 처리
- 리소스 제한 관리

이 구조를 통해 Media2Cloud는 대규모 미디어 파일을 효율적으로 수집하고 처리할 수 있는 확장 가능한 파이프라인을 제공합니다.