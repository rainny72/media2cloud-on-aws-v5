# Media2Cloud v5 Lambda 함수 기능별 동작 설명

## 1. Lambda 함수 개요

Media2Cloud v5는 다양한 Lambda 함수들을 통해 미디어 처리 워크플로우를 구현합니다. 각 함수는 특정 기능을 담당하며, Step Functions를 통해 오케스트레이션됩니다.

### 1.1 함수 분류
- **메인 처리 함수**: 워크플로우 진입점 및 주요 로직
- **수집 함수**: 미디어 파일 수집 및 메타데이터 추출
- **분석 함수**: AI/ML 기반 콘텐츠 분석
- **API 함수**: REST API 처리
- **유틸리티 함수**: 보조 기능 및 상태 관리

## 2. 메인 처리 함수

### 2.1 main-s3event
**파일**: `lambda-source/main-s3event/index.js`

#### 기능
- S3 이벤트 트리거 처리
- 미디어 파일 타입 검증
- 메인 워크플로우 시작

#### 주요 동작
```javascript
exports.handler = async (event, context) => {
  // 1. S3 이벤트에서 버킷과 키 추출
  const bucket = event.detail.bucket.name;
  const key = event.detail.object.key;
  
  // 2. 파일 타입 검증 (Magic Number 사용)
  const magic = await getMagic(bucket, key);
  if (!typeSupported(magic.mime)) {
    return undefined; // 지원하지 않는 타입은 무시
  }
  
  // 3. UUID 생성 및 워크플로우 시작
  const uuid = randomGenerateUuid();
  const stateMachineArn = `arn:aws:states:${region}:${accountId}:stateMachine:${prefix}-main`;
  
  return stepfunctionClient.send(new StartExecutionCommand({
    stateMachineArn,
    name: `${fileName}_${suffix}`,
    input: JSON.stringify(params)
  }));
};
```

#### 지원 미디어 타입
- **비디오**: MP4, MOV, AVI, MKV, WebM
- **오디오**: MP3, WAV, FLAC, AAC, OGG
- **이미지**: JPEG, PNG, GIF, TIFF, BMP
- **문서**: PDF, DOC, DOCX, TXT

### 2.2 main-error-handler
**파일**: `lambda-source/main-error-handler/index.js`

#### 기능
- 워크플로우 오류 처리
- 오류 알림 발송
- 복구 작업 수행

## 3. 수집(Ingest) 함수

### 3.1 ingest-main
**파일**: `lambda-source/ingest-main/index.js`

#### 기능
- 수집 워크플로우 메인 로직
- DynamoDB 레코드 관리
- 상태 업데이트

#### 주요 상태 처리
```javascript
// 상태별 처리 클래스
const stateHandlers = {
  'StateCreateRecord': StateCreateRecord,
  'StateFixityCompleted': StateFixityCompleted,
  'StateUpdateRecord': StateUpdateRecord,
  'StateIndexIngestResults': StateIndexIngestResults,
  'StateJobCompleted': StateJobCompleted
};

// 상태 처리 실행
const handler = new stateHandlers[operation](stateData);
await handler.process();
```

#### DynamoDB 스키마
```javascript
{
  uuid: 'primary-key',
  bucket: 'source-bucket',
  key: 'source-key',
  timestamp: 'iso-date',
  overallStatus: 'NOT_STARTED|IN_PROGRESS|COMPLETED|ERROR',
  type: 'video|audio|image|document'
}
```

### 3.2 ingest-video
**파일**: `lambda-source/ingest-video/index.js`

#### 기능
- 비디오 파일 기술적 메타데이터 추출
- 프레임 추출 준비
- 트랜스코딩 설정

#### 메타데이터 추출
```javascript
// FFprobe를 통한 메타데이터 추출
const metadata = {
  duration: videoInfo.format.duration,
  bitrate: videoInfo.format.bit_rate,
  width: videoInfo.streams[0].width,
  height: videoInfo.streams[0].height,
  frameRate: eval(videoInfo.streams[0].r_frame_rate),
  codec: videoInfo.streams[0].codec_name
};
```

### 3.3 ingest-audio
**파일**: `lambda-source/ingest-audio/index.js`

#### 기능
- 오디오 파일 메타데이터 추출
- 오디오 품질 분석
- 채널 정보 추출

### 3.4 ingest-image
**파일**: `lambda-source/ingest-image/index.js`

#### 기능
- 이미지 메타데이터 추출
- EXIF 데이터 처리
- 썸네일 생성

### 3.5 ingest-document
**파일**: `lambda-source/ingest-document/index.js`

#### 기능
- 문서 메타데이터 추출
- 페이지 수 계산
- 텍스트 추출 준비

### 3.6 ingest-fixity
**파일**: `lambda-source/ingest-fixity/index.js`

#### 기능
- 파일 무결성 검증
- 체크섬 계산 (MD5, SHA256)
- 파일 손상 여부 확인

```javascript
// 체크섬 계산
const calculateChecksum = async (bucket, key) => {
  const stream = s3.getObject({ Bucket: bucket, Key: key }).createReadStream();
  const hash = crypto.createHash('md5');
  
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
};
```

## 4. 분석(Analysis) 함수

### 4.1 analysis-main
**파일**: `lambda-source/analysis-main/index.js`

#### 기능
- 분석 워크플로우 오케스트레이션
- AI 옵션 설정 관리
- 병렬 분석 작업 준비

#### 분석 준비 로직
```javascript
const prepareAnalysis = async (stateData) => {
  const { aiOptions } = stateData.input;
  const iterators = [];
  
  // 비디오 분석 준비
  if (aiOptions.video && aiOptions.video.enabled) {
    iterators.push({
      type: 'video',
      analysisStateMachineArn: VIDEO_ANALYSIS_ARN,
      options: aiOptions.video
    });
  }
  
  // 오디오 분석 준비
  if (aiOptions.audio && aiOptions.audio.enabled) {
    iterators.push({
      type: 'audio', 
      analysisStateMachineArn: AUDIO_ANALYSIS_ARN,
      options: aiOptions.audio
    });
  }
  
  return { iterators };
};
```

### 4.2 analysis-video
**파일**: `lambda-source/analysis-video/index.js`

#### 기능
- Amazon Rekognition 비디오 분석
- 객체 감지, 얼굴 인식, 유명인 인식
- 텍스트 추출, 장면 분할

#### Rekognition 작업 시작
```javascript
const startRekognitionJob = async (type, params) => {
  const commands = {
    'celeb': StartCelebrityRecognitionCommand,
    'face': StartFaceDetectionCommand,
    'label': StartLabelDetectionCommand,
    'text': StartTextDetectionCommand,
    'segment': StartSegmentDetectionCommand
  };
  
  const command = new commands[type](params);
  return rekognitionClient.send(command);
};
```

### 4.3 analysis-audio
**파일**: `lambda-source/analysis-audio/index.js`

#### 기능
- Amazon Transcribe 음성 인식
- 화자 분리 (PyannoteAudio)
- 오디오 향상 (DeepFilterNet)

#### Transcribe 작업 시작
```javascript
const startTranscribeJob = async (audioUri, jobName) => {
  const params = {
    TranscriptionJobName: jobName,
    Media: { MediaFileUri: audioUri },
    MediaFormat: 'mp4',
    LanguageCode: 'auto',
    Settings: {
      ShowSpeakerLabels: true,
      MaxSpeakerLabels: 10
    }
  };
  
  return transcribeClient.send(new StartTranscriptionJobCommand(params));
};
```

### 4.4 analysis-image
**파일**: `lambda-source/analysis-image/index.js`

#### 기능
- Amazon Rekognition 이미지 분석
- 얼굴 분석 (FaceAPI)
- 텍스트 추출 (Textract)

### 4.5 analysis-document
**파일**: `lambda-source/analysis-document/index.js`

#### 기능
- Amazon Textract OCR
- Amazon Comprehend 자연어 처리
- 엔티티 및 키워드 추출

### 4.6 analysis-post-process
**파일**: `lambda-source/analysis-post-process/index.js`

#### 기능
- 분석 결과 통합 및 정규화
- 메타데이터 생성
- OpenSearch 인덱싱 준비

## 5. 특수 처리 함수

### 5.1 frame-extraction
**파일**: `lambda-source/frame-extraction/index.js`

#### 기능
- 비디오에서 키프레임 추출
- 썸네일 생성
- 장면 변화 감지

```javascript
// FFmpeg를 통한 프레임 추출
const extractFrames = async (videoPath, outputDir, interval = 1) => {
  const command = [
    'ffmpeg',
    '-i', videoPath,
    '-vf', `fps=1/${interval}`,
    '-q:v', '2',
    `${outputDir}/frame_%04d.jpg`
  ];
  
  return execCommand(command);
};
```

### 5.2 audio-extraction
**파일**: `lambda-source/audio-extraction/index.js`

#### 기능
- 비디오에서 오디오 트랙 추출
- 오디오 포맷 변환
- 품질 최적화

### 5.3 face-recognition
**파일**: `lambda-source/face-recognition/index.js`

#### 기능
- 얼굴 컬렉션 관리
- 얼굴 매칭 및 검색
- 얼굴 임베딩 생성

### 5.4 openh264-transcode
**파일**: `lambda-source/openh264-transcode/index.js`

#### 기능
- H.264 코덱으로 트랜스코딩
- 다중 해상도 생성
- 스트리밍 최적화

## 6. API 처리 함수

### 6.1 api
**파일**: `lambda-source/api/index.js`

#### 기능
- REST API 요청 라우팅
- 인증 및 권한 검증
- 응답 포맷팅

#### API 라우팅
```javascript
const getProcessor = (operation) => {
  const processors = {
    'assets': AssetOp,
    'analysis': AnalysisOp,
    'search': SearchOp,
    'execution': StepOp,
    'rekognition': RekognitionOp,
    'settings': SettingsOp
  };
  
  return new processors[operation](request);
};
```

## 7. 상태 관리 함수

### 7.1 ingest-status-updater
**파일**: `lambda-source/ingest-status-updater/index.js`

#### 기능
- 수집 상태 실시간 업데이트
- IoT Core 메시지 발송
- 진행률 계산

### 7.2 analysis-status-updater
**파일**: `lambda-source/analysis-status-updater/index.js`

#### 기능
- 분석 상태 실시간 업데이트
- 분석 진행률 추적
- 오류 상태 관리

### 7.3 backlog-status-updater
**파일**: `lambda-source/backlog-status-updater/index.js`

#### 기능
- 백로그 작업 상태 관리
- 대기열 모니터링
- 우선순위 관리

## 8. 유틸리티 함수

### 8.1 custom-resources
**파일**: `lambda-source/custom-resources/index.js`

#### 기능
- CloudFormation 커스텀 리소스 처리
- 초기 설정 작업
- 리소스 정리

### 8.2 asset-removal
**파일**: `lambda-source/asset-removal/index.js`

#### 기능
- 미디어 자산 완전 삭제
- 관련 메타데이터 정리
- S3, DynamoDB, OpenSearch 동기화

### 8.3 update-face-indexer
**파일**: `lambda-source/update-face-indexer/index.js`

#### 기능
- 얼굴 인덱스 업데이트
- 컬렉션 동기화
- 인덱스 최적화

## 9. Amazon Q 통합 함수

### 9.1 update-amazonq-bucket
**파일**: `lambda-source/update-amazonq-bucket/index.js`

#### 기능
- Amazon Q 버킷으로 메타데이터 동기화
- 검색 인덱스 업데이트
- 대화형 AI 데이터 준비

## 10. 성능 최적화

### 10.1 메모리 및 타임아웃 설정
```javascript
// 함수별 최적 설정
const lambdaConfigs = {
  'api': { memory: 256, timeout: 30 },
  'ingest-main': { memory: 512, timeout: 300 },
  'analysis-video': { memory: 1024, timeout: 900 },
  'frame-extraction': { memory: 2048, timeout: 600 }
};
```

### 10.2 동시 실행 제한
- 비용 최적화를 위한 동시 실행 수 제한
- 다운스트림 서비스 보호

### 10.3 콜드 스타트 최적화
- 공통 라이브러리 Lambda Layer 사용
- 초기화 코드 최적화

## 11. 오류 처리 및 재시도

### 11.1 재시도 전략
```javascript
const retryConfig = {
  maxAttempts: 3,
  backoffRate: 2,
  intervalSeconds: 1
};
```

### 11.2 오류 분류
- **일시적 오류**: 자동 재시도
- **영구적 오류**: 즉시 실패 처리
- **부분적 오류**: 부분 재처리

## 12. 모니터링 및 로깅

### 12.1 CloudWatch 로그
- 구조화된 로깅
- 오류 추적
- 성능 메트릭

### 12.2 X-Ray 추적
- 분산 추적
- 성능 병목 식별
- 의존성 맵

### 12.3 커스텀 메트릭
```javascript
// 커스텀 메트릭 발송
await cloudWatch.putMetricData({
  Namespace: 'Media2Cloud',
  MetricData: [{
    MetricName: 'ProcessingTime',
    Value: processingTime,
    Unit: 'Seconds'
  }]
}).promise();
```