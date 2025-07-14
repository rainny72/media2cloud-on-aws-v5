# Media2Cloud v5 Step Functions Workflow 설명

## 1. Step Functions 개요

Media2Cloud v5는 AWS Step Functions를 사용하여 복잡한 미디어 처리 워크플로우를 오케스트레이션합니다. 각 워크플로우는 특정 기능을 담당하며, 상호 연동하여 전체 미디어 처리 파이프라인을 구성합니다.

### 1.1 워크플로우 아키텍처
```
Main Workflow
├── Ingest Workflow
│   ├── Fixity Workflow
│   ├── Video Ingest Workflow
│   ├── Audio Ingest Workflow
│   ├── Image Ingest Workflow
│   └── Document Ingest Workflow
└── Analysis Workflow
    ├── Video Analysis Workflow
    ├── Audio Analysis Workflow
    ├── Image Analysis Workflow
    ├── Document Analysis Workflow
    └── Post-Process Workflow
```

## 2. 메인 워크플로우 (main-v5.json)

### 2.1 워크플로우 개요
메인 워크플로우는 전체 미디어 처리 프로세스의 진입점으로, 수집(Ingest)과 분석(Analysis) 워크플로우를 순차적으로 실행합니다.

### 2.2 워크플로우 구조
```json
{
  "Comment": "main state machine to run ingest and analysis sub state machines",
  "StartAt": "Start ingest state machine",
  "States": {
    "Start ingest state machine": {
      "Type": "Task",
      "Resource": "arn:aws:states:::states:startExecution.sync:2",
      "Next": "Start analysis state machine"
    },
    "Start analysis state machine": {
      "Type": "Task", 
      "Resource": "arn:aws:states:::states:startExecution.sync:2",
      "End": true
    }
  }
}
```

### 2.3 실행 흐름
1. **수집 워크플로우 시작**: 미디어 파일 수집 및 기본 메타데이터 추출
2. **분석 워크플로우 시작**: AI/ML 기반 콘텐츠 분석
3. **완료**: 전체 처리 완료

## 3. 수집 워크플로우 (ingest-main-v5.json)

### 3.1 워크플로우 개요
미디어 파일의 기본 정보 수집, 기술적 메타데이터 추출, 파일 무결성 검증을 담당합니다.

### 3.2 주요 단계

#### 3.2.1 Create Record
```javascript
// Lambda 함수 호출
{
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke",
  "Parameters": {
    "FunctionName": "ingest-main",
    "Payload": {
      "operation": "StateCreateRecord"
    }
  }
}
```
- DynamoDB에 초기 레코드 생성
- UUID 생성 및 할당
- 기본 메타데이터 설정

#### 3.2.2 Start Fixity (Nested)
```javascript
{
  "Type": "Task",
  "Resource": "arn:aws:states:::states:startExecution.sync:2",
  "Parameters": {
    "StateMachineArn": "ingest-fixity-state-machine"
  }
}
```
- 파일 무결성 검증 워크플로우 실행
- 체크섬 계산 및 검증
- 파일 손상 여부 확인

#### 3.2.3 Media Type Processing
- 미디어 타입별 전용 워크플로우 실행
- 비디오, 오디오, 이미지, 문서별 처리

#### 3.2.4 Index Ingest Results
- OpenSearch에 수집 결과 인덱싱
- 검색 가능한 메타데이터 생성

## 4. 분석 워크플로우 (analysis-main-v5.json)

### 4.1 워크플로우 개요
AI/ML 서비스를 활용한 콘텐츠 분석을 담당하며, 병렬 처리를 통해 효율성을 극대화합니다.

### 4.2 주요 단계

#### 4.2.1 Prepare Analysis
```javascript
{
  "Type": "Task",
  "Resource": "arn:aws:states:::lambda:invoke",
  "Parameters": {
    "operation": "prepare-analysis"
  }
}
```
- 분석 작업 준비
- AI 옵션 설정 확인
- 병렬 처리를 위한 작업 분할

#### 4.2.2 Map Processing
```javascript
{
  "Type": "Map",
  "MaxConcurrency": 4,
  "ItemsPath": "$.data.iterators",
  "ItemProcessor": {
    "StartAt": "Run media analysis state machine by type"
  }
}
```
- 최대 4개 동시 실행
- 미디어 타입별 분석 워크플로우 병렬 실행

#### 4.2.3 Collect Analysis Results
- 병렬 분석 결과 수집 및 통합
- 메타데이터 정규화

#### 4.2.4 Post Process (조건부)
- 비디오/오디오 분석 시에만 실행
- 추가 후처리 작업 수행

## 5. 미디어 타입별 워크플로우

### 5.1 비디오 분석 워크플로우 (analysis-video-v5.json)

#### 주요 기능
- **객체 감지**: Amazon Rekognition Labels
- **얼굴 인식**: Amazon Rekognition Faces
- **유명인 인식**: Amazon Rekognition Celebrities
- **텍스트 추출**: Amazon Rekognition Text
- **장면 분할**: Amazon Rekognition Segments
- **콘텐츠 조정**: Amazon Rekognition Moderation

#### 워크플로우 구조
```javascript
{
  "StartAt": "Check video analysis options",
  "States": {
    "Check video analysis options": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.input.rekognition.celeb",
          "BooleanEquals": true,
          "Next": "Start celebrity detection"
        }
      ]
    },
    "Start celebrity detection": {
      "Type": "Task",
      "Resource": "arn:aws:states:::aws-sdk:rekognition:startCelebrityRecognition"
    }
  }
}
```

### 5.2 오디오 분석 워크플로우 (analysis-audio-v5.json)

#### 주요 기능
- **음성 인식**: Amazon Transcribe
- **화자 분리**: PyannoteAudio (ECR)
- **오디오 향상**: DeepFilterNet (ECR)
- **오디오 분류**: AudiosetTagging (ECR)
- **감정 분석**: Amazon Comprehend

#### 고급 오디오 처리
```javascript
{
  "StartAt": "Audio extraction",
  "States": {
    "Audio extraction": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Next": "Run WhisperX"
    },
    "Run WhisperX": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "run-whisperx"
      }
    }
  }
}
```

### 5.3 이미지 분석 워크플로우 (analysis-image-v5.json)

#### 주요 기능
- **객체 감지**: Amazon Rekognition
- **얼굴 분석**: FaceAPI (ECR)
- **얼굴 임베딩**: FaceNet (ECR)
- **텍스트 추출**: Amazon Textract
- **콘텐츠 조정**: Amazon Rekognition Moderation

### 5.4 문서 분석 워크플로우 (analysis-document-v5.json)

#### 주요 기능
- **OCR**: Amazon Textract
- **엔티티 추출**: Amazon Comprehend
- **키워드 추출**: Amazon Comprehend
- **감정 분석**: Amazon Comprehend

## 6. 특수 워크플로우

### 6.1 얼굴 인식 워크플로우 (face-recognition-v5.json)

#### 기능
- 얼굴 컬렉션 관리
- 얼굴 매칭 및 검색
- 얼굴 인덱스 업데이트

### 6.2 자산 제거 워크플로우 (asset-removal-v5.json)

#### 기능
- S3 객체 삭제
- DynamoDB 레코드 삭제
- OpenSearch 인덱스 삭제
- 관련 메타데이터 정리

### 6.3 Amazon Q 통합 워크플로우 (amazon-q-integration-v5.json)

#### 기능
- 메타데이터 Amazon Q 버킷으로 동기화
- 검색 인덱스 업데이트
- 대화형 AI 준비

## 7. 워크플로우 실행 패턴

### 7.1 동기 실행 (sync:2)
```javascript
{
  "Type": "Task",
  "Resource": "arn:aws:states:::states:startExecution.sync:2",
  "Parameters": {
    "StateMachineArn": "nested-state-machine-arn",
    "Input": "$"
  },
  "OutputPath": "$.Output"
}
```
- 중첩된 워크플로우 완료까지 대기
- 결과를 다음 단계로 전달

### 7.2 비동기 실행
```javascript
{
  "Type": "Task", 
  "Resource": "arn:aws:states:::states:startExecution",
  "Parameters": {
    "StateMachineArn": "async-state-machine-arn"
  }
}
```
- 워크플로우 시작 후 즉시 다음 단계 진행

### 7.3 병렬 실행 (Map State)
```javascript
{
  "Type": "Map",
  "MaxConcurrency": 4,
  "ItemsPath": "$.items",
  "ItemProcessor": {
    "ProcessorConfig": {
      "Mode": "INLINE"
    },
    "StartAt": "ProcessItem"
  }
}
```
- 여러 항목을 동시에 처리
- 동시 실행 수 제한 가능

## 8. 오류 처리 및 재시도

### 8.1 재시도 정책
```javascript
{
  "Retry": [
    {
      "ErrorEquals": [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException"
      ],
      "IntervalSeconds": 1,
      "MaxAttempts": 2,
      "BackoffRate": 1.2
    }
  ]
}
```

### 8.2 오류 처리
```javascript
{
  "Catch": [
    {
      "ErrorEquals": ["States.ALL"],
      "Next": "HandleError",
      "ResultPath": "$.error"
    }
  ]
}
```

## 9. 워크플로우 모니터링

### 9.1 CloudWatch 메트릭
- 실행 횟수
- 성공/실패율
- 실행 시간


### 9.2 X-Ray 추적
- 워크플로우 실행 추적
- 성능 병목 지점 식별
- 의존성 맵 생성

### 9.3 EventBridge 통합
```javascript
{
  "Type": "Task",
  "Resource": "arn:aws:states:::events:putEvents",
  "Parameters": {
    "Entries": [
      {
        "Source": "media2cloud",
        "DetailType": "Workflow Completed",
        "Detail": {
          "uuid.$": "$.uuid",
          "status.$": "$.status"
        }
      }
    ]
  }
}
```

## 10. 성능 최적화

### 10.1 병렬 처리 최적화
- Map State의 MaxConcurrency 조정
- 리소스 사용량에 따른 동적 조정

### 10.2 메모리 및 타임아웃 설정
- Lambda 함수별 최적 메모리 설정
- 워크플로우별 타임아웃 설정

## 10. 보안 고려사항

### 10.1 IAM 역할
- 각 워크플로우별 최소 권한 부여
- 크로스 계정 액세스 제어

### 10.2 데이터 암호화
- 전송 중 암호화 (TLS)
- 저장 시 암호화 (KMS)

### 10.3 로깅 및 감사
- CloudTrail을 통한 API 호출 로깅
- 민감한 데이터 마스킹