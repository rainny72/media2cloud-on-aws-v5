# Media2Cloud v5 DynamoDB 테이블 구성 설명

## 1. DynamoDB 개요

Media2Cloud v5는 Amazon DynamoDB를 사용하여 미디어 자산의 메타데이터, 처리 상태, 분석 결과를 저장합니다. 각 테이블은 특정 목적에 최적화되어 설계되었습니다.

### 1.1 테이블 구조 개요
```
DynamoDB Tables
├── Ingest Table (수집 데이터)
├── Analysis Table (분석 결과)
├── Face Indexer Table (얼굴 인덱스)
└── Backlog Table (백로그 관리)
```

### 1.2 설계 원칙
- **Single Table Design**: 관련 데이터를 하나의 테이블에 저장
- **NoSQL 최적화**: 관계형 조인 대신 비정규화 설계
- **확장성**: 자동 스케일링 지원
- **성능**: 적절한 파티션 키 설계

## 2. Ingest Table (수집 테이블)

### 2.1 테이블 개요
미디어 파일의 수집 과정에서 생성되는 모든 메타데이터와 상태 정보를 저장합니다.

### 2.2 테이블 스키마
```javascript
{
  TableName: "so0050-{stack-id}-ingest",
  KeySchema: [
    {
      AttributeName: "uuid",
      KeyType: "HASH"  // Partition Key
    }
  ],
  AttributeDefinitions: [
    {
      AttributeName: "uuid",
      AttributeType: "S"
    },
    {
      AttributeName: "timestamp",
      AttributeType: "N"
    },
    {
      AttributeName: "type",
      AttributeType: "S"
    }
  ]
}
```

### 2.3 주요 속성

#### 기본 속성
```javascript
{
  "uuid": "12345678-1234-1234-1234-123456789012",  // Primary Key
  "timestamp": 1640995200000,                       // Unix timestamp
  "type": "video",                                  // video|audio|image|document
  "bucket": "ingest-bucket-name",
  "key": "videos/sample.mp4",
  "fileSize": 104857600,                           // bytes
  "duration": 120.5,                              // seconds (video/audio only)
  "overallStatus": "COMPLETED",                    // NOT_STARTED|IN_PROGRESS|COMPLETED|ERROR
  "progress": 100                                  // 0-100
}
```

#### 메타데이터 속성
```javascript
{
  "input": {
    "destination": {
      "bucket": "proxy-bucket",
      "prefix": "uuid/path/"
    },
    "aiOptions": {
      "celeb": true,
      "face": true,
      "label": true,
      "transcribe": true
    }
  },
  "data": {
    "restore": {
      "tier": "Standard",
      "startTime": "2024-01-01T00:00:00Z",
      "endTime": "2024-01-01T00:05:00Z"
    },
    "checksum": {
      "algorithm": "md5",
      "fileSize": 104857600,
      "computed": "d41d8cd98f00b204e9800998ecf8427e",
      "storeClass": "STANDARD"
    }
  }
}
```

#### 비디오 메타데이터
```javascript
{
  "data": {
    "video": {
      "width": 1920,
      "height": 1080,
      "frameRate": 29.97,
      "bitRate": 5000000,
      "codec": "h264",
      "profile": "High",
      "level": "4.0",
      "pixelFormat": "yuv420p",
      "colorSpace": "bt709"
    },
    "audio": {
      "channels": 2,
      "sampleRate": 48000,
      "bitRate": 128000,
      "codec": "aac",
      "profile": "LC"
    }
  }
}
```

### 2.4 Global Secondary Index (GSI)

#### Type-Timestamp Index
```javascript
{
  IndexName: "type-timestamp-index",
  KeySchema: [
    {
      AttributeName: "type",
      KeyType: "HASH"
    },
    {
      AttributeName: "timestamp", 
      KeyType: "RANGE"
    }
  ],
  Projection: {
    ProjectionType: "ALL"
  }
}
```

#### 사용 사례
```javascript
// 특정 타입의 최근 파일 조회
const params = {
  TableName: 'ingest-table',
  IndexName: 'type-timestamp-index',
  KeyConditionExpression: '#type = :type',
  ExpressionAttributeNames: {
    '#type': 'type'
  },
  ExpressionAttributeValues: {
    ':type': 'video'
  },
  ScanIndexForward: false,  // 최신순 정렬
  Limit: 20
};
```

## 3. Analysis Table (분석 테이블)

### 3.1 테이블 개요
AI/ML 분석 결과와 처리 상태를 저장하는 테이블입니다.

### 3.2 테이블 스키마
```javascript
{
  TableName: "so0050-{stack-id}-analysis",
  KeySchema: [
    {
      AttributeName: "uuid",
      KeyType: "HASH"
    }
  ]
}
```

### 3.3 주요 속성

#### 기본 분석 정보
```javascript
{
  "uuid": "12345678-1234-1234-1234-123456789012",
  "timestamp": 1640995200000,
  "overallStatus": "COMPLETED",
  "progress": 100,
  "startTime": "2024-01-01T00:00:00Z",
  "endTime": "2024-01-01T00:05:00Z",
  "executionArn": "arn:aws:states:us-west-2:123456789012:execution:analysis-main:uuid"
}
```

#### Rekognition 분석 결과
```javascript
{
  "data": {
    "rekognition": {
      "celeb": {
        "status": "COMPLETED",
        "output": "s3://bucket/uuid/rekognition/celeb.json",
        "jobId": "rekognition-job-id",
        "startTime": "2024-01-01T00:00:00Z",
        "endTime": "2024-01-01T00:02:00Z"
      },
      "face": {
        "status": "COMPLETED", 
        "output": "s3://bucket/uuid/rekognition/face.json",
        "jobId": "rekognition-face-job-id"
      },
      "label": {
        "status": "COMPLETED",
        "output": "s3://bucket/uuid/rekognition/label.json",
        "jobId": "rekognition-label-job-id"
      }
    }
  }
}
```

#### Transcribe 분석 결과
```javascript
{
  "data": {
    "transcribe": {
      "status": "COMPLETED",
      "output": "s3://bucket/uuid/transcribe/transcript.json",
      "jobName": "transcribe-job-name",
      "languageCode": "ko-KR",
      "confidence": 0.95,
      "speakers": [
        {
          "speaker": "spk_0",
          "duration": 45.2
        },
        {
          "speaker": "spk_1", 
          "duration": 32.8
        }
      ]
    }
  }
}
```

#### Comprehend 분석 결과
```javascript
{
  "data": {
    "comprehend": {
      "keyphrase": {
        "status": "COMPLETED",
        "output": "s3://bucket/uuid/comprehend/keyphrase.json",
        "jobId": "comprehend-keyphrase-job-id"
      },
      "entity": {
        "status": "COMPLETED",
        "output": "s3://bucket/uuid/comprehend/entity.json",
        "jobId": "comprehend-entity-job-id"
      },
      "sentiment": {
        "status": "COMPLETED",
        "output": "s3://bucket/uuid/comprehend/sentiment.json",
        "jobId": "comprehend-sentiment-job-id"
      }
    }
  }
}
```

### 3.4 분석 상태 관리
```javascript
// 상태 값 정의
const AnalysisStatus = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS', 
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED'
};

// 진행률 계산
const calculateProgress = (analysisData) => {
  const totalJobs = Object.keys(analysisData).length;
  const completedJobs = Object.values(analysisData)
    .filter(job => job.status === 'COMPLETED').length;
  
  return Math.round((completedJobs / totalJobs) * 100);
};
```

## 4. Face Indexer Table (얼굴 인덱서 테이블)

### 4.1 테이블 개요
얼굴 인식 및 매칭을 위한 얼굴 인덱스 정보를 저장합니다.

### 4.2 테이블 스키마
```javascript
{
  TableName: "so0050-{stack-id}-face-indexer",
  KeySchema: [
    {
      AttributeName: "uuid",
      KeyType: "HASH"
    },
    {
      AttributeName: "faceId", 
      KeyType: "RANGE"
    }
  ]
}
```

### 4.3 주요 속성
```javascript
{
  "uuid": "12345678-1234-1234-1234-123456789012",
  "faceId": "face-12345",
  "collectionId": "media2cloud-faces",
  "externalImageId": "uuid/frame_001.jpg",
  "boundingBox": {
    "Width": 0.123,
    "Height": 0.456,
    "Left": 0.234,
    "Top": 0.567
  },
  "confidence": 0.95,
  "landmarks": [
    {
      "Type": "eyeLeft",
      "X": 0.345,
      "Y": 0.678
    }
  ],
  "attributes": {
    "Gender": {
      "Value": "Female",
      "Confidence": 0.92
    },
    "AgeRange": {
      "Low": 25,
      "High": 35
    }
  },
  "timestamp": 1640995200000
}
```

### 4.4 Collection Index
```javascript
{
  IndexName: "collection-timestamp-index",
  KeySchema: [
    {
      AttributeName: "collectionId",
      KeyType: "HASH"
    },
    {
      AttributeName: "timestamp",
      KeyType: "RANGE"
    }
  ]
}
```

## 5. Backlog Table (백로그 테이블)

### 5.1 테이블 개요
처리 대기 중인 작업들을 관리하는 테이블입니다.

### 5.2 테이블 스키마
```javascript
{
  TableName: "so0050-{stack-id}-backlog",
  KeySchema: [
    {
      AttributeName: "id",
      KeyType: "HASH"
    }
  ]
}
```

### 5.3 주요 속성
```javascript
{
  "id": "backlog-12345",
  "type": "custom-labels",
  "status": "PENDING",
  "priority": 1,
  "uuid": "12345678-1234-1234-1234-123456789012",
  "input": {
    "bucket": "source-bucket",
    "key": "path/to/file.mp4"
  },
  "createdAt": 1640995200000,
  "updatedAt": 1640995200000,
  "retryCount": 0,
  "maxRetries": 3
}
```

## 6. 데이터 액세스 패턴

### 6.1 읽기 패턴

#### 단일 항목 조회
```javascript
// UUID로 수집 정보 조회
const getIngestItem = async (uuid) => {
  const params = {
    TableName: 'ingest-table',
    Key: { uuid }
  };
  
  return dynamodb.get(params).promise();
};
```

#### 범위 쿼리
```javascript
// 특정 기간의 비디오 파일 조회
const getVideosByDateRange = async (startDate, endDate) => {
  const params = {
    TableName: 'ingest-table',
    IndexName: 'type-timestamp-index',
    KeyConditionExpression: '#type = :type AND #timestamp BETWEEN :start AND :end',
    ExpressionAttributeNames: {
      '#type': 'type',
      '#timestamp': 'timestamp'
    },
    ExpressionAttributeValues: {
      ':type': 'video',
      ':start': startDate,
      ':end': endDate
    }
  };
  
  return dynamodb.query(params).promise();
};
```

### 6.2 쓰기 패턴

#### 배치 쓰기
```javascript
// 여러 분석 결과 동시 저장
const batchWriteAnalysisResults = async (items) => {
  const params = {
    RequestItems: {
      'analysis-table': items.map(item => ({
        PutRequest: { Item: item }
      }))
    }
  };
  
  return dynamodb.batchWrite(params).promise();
};
```

#### 조건부 업데이트
```javascript
// 상태가 변경된 경우에만 업데이트
const updateStatus = async (uuid, newStatus, currentStatus) => {
  const params = {
    TableName: 'analysis-table',
    Key: { uuid },
    UpdateExpression: 'SET #status = :newStatus, #updatedAt = :now',
    ConditionExpression: '#status = :currentStatus',
    ExpressionAttributeNames: {
      '#status': 'overallStatus',
      '#updatedAt': 'updatedAt'
    },
    ExpressionAttributeValues: {
      ':newStatus': newStatus,
      ':currentStatus': currentStatus,
      ':now': Date.now()
    }
  };
  
  return dynamodb.update(params).promise();
};
```

## 7. 성능 최적화

### 7.1 파티션 키 설계
- **UUID 사용**: 균등한 데이터 분산
- **Hot Partition 방지**: 시간 기반 키 사용 시 주의
- **복합 키**: 정렬 키를 통한 효율적 쿼리

### 7.2 인덱스 전략
```javascript
// 효율적인 GSI 설계
const createGSI = {
  IndexName: 'status-timestamp-index',
  KeySchema: [
    { AttributeName: 'overallStatus', KeyType: 'HASH' },
    { AttributeName: 'timestamp', KeyType: 'RANGE' }
  ],
  Projection: {
    ProjectionType: 'INCLUDE',
    NonKeyAttributes: ['uuid', 'type', 'progress']
  }
};
```

### 7.3 읽기/쓰기 용량 관리
```javascript
// Auto Scaling 설정
const autoScalingConfig = {
  BillingMode: 'PAY_PER_REQUEST',  // On-Demand
  // 또는 Provisioned 모드
  ProvisionedThroughput: {
    ReadCapacityUnits: 5,
    WriteCapacityUnits: 5
  }
};
```

## 8. 데이터 보안

### 8.1 암호화
```javascript
// 저장 시 암호화 설정
const encryptionConfig = {
  SSESpecification: {
    Enabled: true,
    SSEType: 'KMS',
    KMSMasterKeyId: 'alias/aws/dynamodb'
  }
};
```

### 8.2 액세스 제어
```javascript
// IAM 정책 예시
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:region:account:table/ingest-table",
        "arn:aws:dynamodb:region:account:table/ingest-table/index/*"
      ],
      "Condition": {
        "ForAllValues:StringEquals": {
          "dynamodb:Attributes": ["uuid", "timestamp", "type"]
        }
      }
    }
  ]
}
```

## 9. 백업 및 복구

### 9.1 Point-in-Time Recovery
```javascript
// PITR 활성화
const pitrConfig = {
  PointInTimeRecoveryEnabled: true
};
```

### 9.2 백업 전략
```javascript
// 자동 백업 설정
const backupConfig = {
  BackupPolicy: {
    PointInTimeRecoveryEnabled: true
  },
  ContinuousBackups: {
    PointInTimeRecoveryDescription: {
      PointInTimeRecoveryStatus: 'ENABLED'
    }
  }
};
```

## 10. 모니터링 및 알림

### 10.1 CloudWatch 메트릭
- **읽기/쓰기 용량 사용률**
- **스로틀링 이벤트**
- **시스템 오류**
- **사용자 오류**

### 10.2 알림 설정
```javascript
// CloudWatch 알람 설정
const createAlarm = {
  AlarmName: 'DynamoDB-HighReadThrottle',
  MetricName: 'ReadThrottledEvents',
  Namespace: 'AWS/DynamoDB',
  Statistic: 'Sum',
  Period: 300,
  EvaluationPeriods: 2,
  Threshold: 10,
  ComparisonOperator: 'GreaterThanThreshold'
};
```

