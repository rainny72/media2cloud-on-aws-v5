# Media2Cloud v5 Amazon Q Business 대화형 검색 서비스

## 1. Amazon Q Business 개요

Media2Cloud v5는 Amazon Q Business와 통합하여 자연어 기반의 대화형 검색 서비스를 제공합니다. 사용자는 일반적인 언어로 질문하여 미디어 콘텐츠를 검색하고 분석 결과를 얻을 수 있습니다.

### 1.1 주요 기능
- **자연어 질의**: 일반적인 언어로 미디어 검색
- **대화형 인터페이스**: 연속적인 질문과 답변
- **컨텍스트 이해**: 이전 대화 내용을 기반으로 한 응답
- **다국어 지원**: 한국어, 영어 등 다양한 언어 지원
- **실시간 응답**: 빠른 검색 및 응답 생성

### 1.2 통합 아키텍처
```
Media2Cloud → Metadata Sync → Amazon Q Data Source → Q Business Application
                                                    ↓
User Query → Q Business → RAG Processing → Response Generation
```

## 2. 시스템 구성

### 2.1 Amazon Q Business 애플리케이션 설정

#### 애플리케이션 생성
```yaml
QBusinessApplication:
  ApplicationName: Media2Cloud-QBusiness
  Description: "대화형 미디어 검색 서비스"
  RoleArn: "arn:aws:iam::account:role/QBusinessServiceRole"
  IdentityCenterInstanceArn: "arn:aws:sso:::instance/ssoins-xxxxxxxxx"
```

#### 데이터 소스 구성
```yaml
DataSource:
  Name: Media2Cloud-DataSource
  Type: S3
  Configuration:
    S3Configuration:
      BucketName: !Ref AmazonQBucket
      InclusionPrefixes:
        - "metadata/"
        - "transcripts/"
        - "analysis/"
      DocumentTitleFieldName: "title"
      FieldMappings:
        - DataSourceFieldName: "uuid"
          DateFieldFormat: "yyyy-MM-dd'T'HH:mm:ss'Z'"
          IndexFieldName: "uuid"
          IndexFieldType: "STRING"
```

### 2.2 메타데이터 동기화 워크플로우

#### Step Functions 워크플로우 (amazon-q-integration-v5.json)
```json
{
  "Comment": "Amazon Q Business 데이터 동기화 워크플로우",
  "StartAt": "Prepare Q Data",
  "States": {
    "Prepare Q Data": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "update-amazonq-bucket",
        "Payload": {
          "operation": "prepare-q-data"
        }
      },
      "Next": "Upload to Q Bucket"
    },
    "Upload to Q Bucket": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "update-amazonq-bucket",
        "Payload": {
          "operation": "upload-to-q-bucket"
        }
      },
      "Next": "Trigger Data Source Sync"
    },
    "Trigger Data Source Sync": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "update-amazonq-bucket",
        "Payload": {
          "operation": "trigger-sync"
        }
      },
      "End": true
    }
  }
}
```

### 2.3 Lambda 함수 구현

#### update-amazonq-bucket Lambda 함수
```javascript
const { QBusinessClient } = require('@aws-sdk/client-qbusiness');
const { S3Client } = require('@aws-sdk/client-s3');

exports.handler = async (event, context) => {
  const { operation, uuid, analysisData } = event;
  
  switch (operation) {
    case 'prepare-q-data':
      return await prepareQData(uuid, analysisData);
    case 'upload-to-q-bucket':
      return await uploadToQBucket(uuid, analysisData);
    case 'trigger-sync':
      return await triggerDataSourceSync();
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
};

// Q Business용 데이터 준비
const prepareQData = async (uuid, analysisData) => {
  const qDocument = {
    uuid: uuid,
    title: analysisData.key || `Media Asset ${uuid}`,
    content: generateSearchableContent(analysisData),
    metadata: {
      type: analysisData.type,
      timestamp: analysisData.timestamp,
      duration: analysisData.duration,
      fileSize: analysisData.fileSize,
      bucket: analysisData.bucket,
      key: analysisData.key
    },
    attributes: extractAttributes(analysisData)
  };
  
  return qDocument;
};

// 검색 가능한 콘텐츠 생성
const generateSearchableContent = (analysisData) => {
  let content = [];
  
  // 트랜스크립트 추가
  if (analysisData.transcribe?.transcript) {
    content.push(`음성 내용: ${analysisData.transcribe.transcript}`);
  }
  
  // 레이블 추가
  if (analysisData.rekognition?.labels) {
    const labels = analysisData.rekognition.labels
      .map(label => label.name)
      .join(', ');
    content.push(`감지된 객체: ${labels}`);
  }
  
  // 유명인 추가
  if (analysisData.rekognition?.celebrities) {
    const celebs = analysisData.rekognition.celebrities
      .map(celeb => celeb.name)
      .join(', ');
    content.push(`등장 인물: ${celebs}`);
  }
  
  // 키워드 추가
  if (analysisData.comprehend?.keyPhrases) {
    const phrases = analysisData.comprehend.keyPhrases
      .map(phrase => phrase.text)
      .join(', ');
    content.push(`주요 키워드: ${phrases}`);
  }
  
  return content.join('\n\n');
};
```

## 3. 데이터 구조 및 포맷

### 3.1 Q Business 문서 스키마
```json
{
  "uuid": "12345678-1234-1234-1234-123456789012",
  "title": "샘플 비디오 - 회의 녹화",
  "content": "음성 내용: 안녕하세요. 오늘 회의를 시작하겠습니다...\n\n감지된 객체: 사람, 테이블, 컴퓨터, 문서\n\n등장 인물: 김철수, 이영희\n\n주요 키워드: 프로젝트 계획, 일정 관리, 예산 검토",
  "metadata": {
    "type": "video",
    "timestamp": 1640995200000,
    "duration": 1800.5,
    "fileSize": 524288000,
    "bucket": "media-bucket",
    "key": "videos/meeting-2024-01-01.mp4",
    "language": "ko-KR",
    "speakers": ["SPEAKER_00", "SPEAKER_01"],
    "categories": ["회의", "업무"],
    "sentiment": "NEUTRAL"
  },
  "attributes": {
    "video_resolution": "1920x1080",
    "video_codec": "h264",
    "audio_codec": "aac",
    "creation_date": "2024-01-01T09:00:00Z",
    "location": "서울 본사 회의실",
    "department": "기획팀"
  }
}
```

### 3.2 메타데이터 매핑
```javascript
// 분석 결과를 Q Business 형식으로 변환
const mapToQBusinessFormat = (analysisResult) => {
  return {
    // 기본 정보
    uuid: analysisResult.uuid,
    title: generateTitle(analysisResult),
    content: generateContent(analysisResult),
    
    // 메타데이터
    metadata: {
      // 파일 정보
      type: analysisResult.type,
      fileSize: analysisResult.fileSize,
      duration: analysisResult.duration,
      
      // 시간 정보
      timestamp: analysisResult.timestamp,
      createdAt: analysisResult.createdAt,
      
      // 언어 및 지역
      language: analysisResult.transcribe?.languageCode,
      
      // 감정 분석
      sentiment: analysisResult.comprehend?.sentiment?.sentiment,
      
      // 카테고리
      categories: extractCategories(analysisResult),
      
      // 화자 정보
      speakers: analysisResult.transcribe?.speakers?.map(s => s.speaker)
    },
    
    // 추가 속성
    attributes: {
      // 기술적 메타데이터
      video_resolution: `${analysisResult.video?.width}x${analysisResult.video?.height}`,
      video_codec: analysisResult.video?.codec,
      audio_codec: analysisResult.audio?.codec,
      
      // 비즈니스 메타데이터
      department: extractDepartment(analysisResult),
      project: extractProject(analysisResult),
      location: extractLocation(analysisResult)
    }
  };
};
```

## 4. 대화형 검색 구현

### 4.1 자연어 쿼리 처리
```javascript
// Q Business API를 통한 자연어 검색
const searchWithNaturalLanguage = async (query, conversationId, userId) => {
  const qBusinessClient = new QBusinessClient({
    region: process.env.AWS_REGION
  });
  
  const params = {
    applicationId: process.env.Q_APPLICATION_ID,
    conversationId: conversationId,
    userId: userId,
    userMessage: query,
    clientToken: generateClientToken()
  };
  
  try {
    const response = await qBusinessClient.chatSync(params);
    return {
      answer: response.systemMessage,
      sourceAttributions: response.sourceAttributions,
      conversationId: response.conversationId,
      systemMessageId: response.systemMessageId
    };
  } catch (error) {
    console.error('Q Business 검색 오류:', error);
    throw error;
  }
};
```

### 4.2 컨텍스트 관리
```javascript
// 대화 컨텍스트 관리
class ConversationManager {
  constructor() {
    this.conversations = new Map();
  }
  
  // 새 대화 시작
  startConversation(userId) {
    const conversationId = generateConversationId();
    this.conversations.set(conversationId, {
      userId: userId,
      startTime: Date.now(),
      messages: [],
      context: {}
    });
    return conversationId;
  }
  
  // 메시지 추가
  addMessage(conversationId, message, response) {
    const conversation = this.conversations.get(conversationId);
    if (conversation) {
      conversation.messages.push({
        timestamp: Date.now(),
        userMessage: message,
        systemResponse: response
      });
      
      // 컨텍스트 업데이트
      this.updateContext(conversationId, message, response);
    }
  }
  
  // 컨텍스트 업데이트
  updateContext(conversationId, message, response) {
    const conversation = this.conversations.get(conversationId);
    if (conversation && response.sourceAttributions) {
      // 참조된 문서들을 컨텍스트에 추가
      response.sourceAttributions.forEach(attr => {
        if (attr.snippet) {
          conversation.context[attr.title] = attr.snippet;
        }
      });
    }
  }
}
```

## 5. 사용 사례 및 쿼리 예시

### 5.1 기본 검색 쿼리
```javascript
// 예시 쿼리들
const exampleQueries = [
  // 콘텐츠 기반 검색
  "회의에서 예산에 대해 논의한 비디오를 찾아줘",
  "김철수가 등장하는 모든 영상을 보여줘",
  "지난 달에 업로드된 프레젠테이션 자료는?",
  
  // 감정 기반 검색
  "긍정적인 반응이 많은 비디오를 찾아줘",
  "고객 불만이 포함된 통화 녹음을 찾아줘",
  
  // 기술적 검색
  "10분 이상의 HD 비디오만 보여줘",
  "용량이 100MB 이상인 파일들은?",
  
  // 복합 검색
  "마케팅 팀에서 제작한 영어 프레젠테이션 중에서 제품 소개가 포함된 것을 찾아줘"
];
```

### 5.2 대화형 검색 시나리오
```javascript
// 대화 시나리오 예시
const conversationExample = [
  {
    user: "최근에 업로드된 회의 영상을 찾아줘",
    system: "지난 7일간 업로드된 회의 영상 5개를 찾았습니다. 가장 최근 것은 '2024년 1분기 계획 회의'입니다.",
    context: ["meeting", "recent", "quarterly_planning"]
  },
  {
    user: "그 중에서 예산 관련 내용이 있는 것은?",
    system: "예산 관련 논의가 포함된 영상 2개가 있습니다. '2024년 1분기 계획 회의'에서 15분 30초부터 예산 배정에 대한 논의가 있었습니다.",
    context: ["budget", "quarterly_planning", "allocation"]
  },
  {
    user: "해당 부분의 요약을 보여줘",
    system: "예산 논의 부분 요약:\n- 마케팅 예산 20% 증액 제안\n- IT 인프라 투자 우선순위 논의\n- 인건비 예산 동결 결정\n주요 발언자: 김부장, 이과장",
    context: ["budget_summary", "marketing_increase", "IT_infrastructure"]
  }
];
```

## 6. 고급 기능

### 6.1 RAG (Retrieval-Augmented Generation) 최적화
```javascript
// RAG 성능 향상을 위한 문서 청킹
const optimizeDocumentForRAG = (document) => {
  const chunks = [];
  
  // 트랜스크립트를 의미 단위로 분할
  if (document.transcribe?.segments) {
    let currentChunk = '';
    let chunkStart = 0;
    
    document.transcribe.segments.forEach((segment, index) => {
      currentChunk += segment.text + ' ';
      
      // 청크 크기가 적절하거나 화자가 바뀔 때 분할
      if (currentChunk.length > 500 || 
          (index < document.transcribe.segments.length - 1 && 
           segment.speaker !== document.transcribe.segments[index + 1].speaker)) {
        
        chunks.push({
          content: currentChunk.trim(),
          metadata: {
            type: 'transcript',
            startTime: chunkStart,
            endTime: segment.endTime,
            speaker: segment.speaker
          }
        });
        
        currentChunk = '';
        chunkStart = segment.endTime;
      }
    });
  }
  
  // 분석 결과별로 청크 생성
  if (document.rekognition?.labels) {
    chunks.push({
      content: `감지된 객체 및 장면: ${document.rekognition.labels.map(l => l.name).join(', ')}`,
      metadata: {
        type: 'visual_analysis',
        confidence: Math.max(...document.rekognition.labels.map(l => l.confidence))
      }
    });
  }
  
  return chunks;
};
```

### 6.2 개인화된 검색
```javascript
// 사용자 프로필 기반 개인화
const personalizeSearch = async (query, userId) => {
  // 사용자 검색 히스토리 분석
  const userProfile = await getUserProfile(userId);
  const searchHistory = await getSearchHistory(userId);
  
  // 개인화된 컨텍스트 생성
  const personalizedContext = {
    preferredTopics: userProfile.interests,
    recentSearches: searchHistory.slice(-10),
    department: userProfile.department,
    role: userProfile.role
  };
  
  // Q Business에 개인화된 쿼리 전송
  const enhancedQuery = `
    사용자 컨텍스트: ${JSON.stringify(personalizedContext)}
    
    사용자 질문: ${query}
    
    위 컨텍스트를 고려하여 가장 관련성 높은 결과를 제공해주세요.
  `;
  
  return await searchWithNaturalLanguage(enhancedQuery, null, userId);
};
```

### 6.3 실시간 업데이트
```javascript
// 실시간 데이터 동기화
const setupRealTimeSync = () => {
  // EventBridge 규칙 설정
  const eventRule = {
    Name: 'Media2Cloud-QBusiness-Sync',
    EventPattern: {
      source: ['media2cloud'],
      'detail-type': ['Analysis Completed', 'Ingest Completed'],
      detail: {
        status: ['COMPLETED']
      }
    },
    Targets: [{
      Id: '1',
      Arn: 'arn:aws:states:region:account:stateMachine:amazon-q-integration',
      RoleArn: 'arn:aws:iam::account:role/EventBridgeRole'
    }]
  };
  
  return eventRule;
};

// 증분 업데이트
const incrementalUpdate = async (uuid, changes) => {
  const existingDoc = await getQBusinessDocument(uuid);
  const updatedDoc = mergeChanges(existingDoc, changes);
  
  await uploadToQBucket(uuid, updatedDoc);
  await triggerDataSourceSync();
};
```

## 7. 성능 최적화

### 7.1 인덱싱 최적화
```javascript
// 효율적인 문서 구조
const optimizeDocumentStructure = (document) => {
  return {
    // 검색에 중요한 필드를 앞쪽에 배치
    title: document.title,
    summary: generateSummary(document),
    keywords: extractKeywords(document),
    
    // 상세 내용
    content: document.content,
    
    // 메타데이터는 구조화하여 배치
    metadata: {
      // 자주 필터링되는 필드
      type: document.type,
      date: document.timestamp,
      language: document.language,
      
      // 기타 메타데이터
      ...document.metadata
    }
  };
};
```

### 7.2 캐싱 전략
```javascript
// 자주 사용되는 쿼리 캐싱
const cachedQBusinessSearch = async (query, userId) => {
  const cacheKey = `qbusiness:${userId}:${hashQuery(query)}`;
  
  // 캐시 확인
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }
  
  // Q Business 검색 실행
  const result = await searchWithNaturalLanguage(query, null, userId);
  
  // 결과 캐싱 (10분)
  await redis.setex(cacheKey, 600, JSON.stringify(result));
  
  return result;
};
```

## 8. 모니터링 및 분석

### 8.1 사용량 추적
```javascript
// 검색 패턴 분석
const trackSearchMetrics = async (query, userId, response) => {
  const metrics = {
    timestamp: Date.now(),
    userId: userId,
    query: query,
    responseTime: response.responseTime,
    resultCount: response.sourceAttributions?.length || 0,
    satisfaction: null // 사용자 피드백으로 업데이트
  };
  
  // CloudWatch 메트릭 전송
  await cloudWatch.putMetricData({
    Namespace: 'Media2Cloud/QBusiness',
    MetricData: [{
      MetricName: 'SearchQueries',
      Value: 1,
      Unit: 'Count',
      Dimensions: [{
        Name: 'UserId',
        Value: userId
      }]
    }]
  }).promise();
  
  // 상세 로그 저장
  await saveSearchLog(metrics);
};
```

### 8.2 품질 모니터링
```javascript
// 응답 품질 평가
const evaluateResponseQuality = (query, response) => {
  const qualityMetrics = {
    relevanceScore: calculateRelevance(query, response),
    completenessScore: calculateCompleteness(response),
    accuracyScore: calculateAccuracy(response),
    responseTime: response.responseTime
  };
  
  // 품질 임계값 확인
  if (qualityMetrics.relevanceScore < 0.7) {
    console.warn('Low relevance score detected:', qualityMetrics);
    // 알림 또는 재학습 트리거
  }
  
  return qualityMetrics;
};
```

## 9. 보안 및 권한 관리

### 9.1 사용자 권한 제어
```javascript
// 사용자별 데이터 접근 제어
const enforceDataAccess = async (userId, documentId) => {
  const userPermissions = await getUserPermissions(userId);
  const documentMetadata = await getDocumentMetadata(documentId);
  
  // 부서별 접근 제어
  if (documentMetadata.department && 
      !userPermissions.departments.includes(documentMetadata.department)) {
    throw new Error('Access denied: Department restriction');
  }
  
  // 보안 등급 확인
  if (documentMetadata.securityLevel > userPermissions.maxSecurityLevel) {
    throw new Error('Access denied: Security level restriction');
  }
  
  return true;
};
```

### 9.2 데이터 마스킹
```javascript
// 민감한 정보 마스킹
const maskSensitiveData = (content, userRole) => {
  let maskedContent = content;
  
  // 개인정보 마스킹
  if (userRole !== 'admin') {
    maskedContent = maskedContent
      .replace(/\d{3}-\d{4}-\d{4}/g, '***-****-****') // 전화번호
      .replace(/\d{6}-\d{7}/g, '******-*******')      // 주민번호
      .replace(/[\w.-]+@[\w.-]+\.\w+/g, '***@***.***'); // 이메일
  }
  
  return maskedContent;
};
```

## 10. 비용 최적화

### 10.1 효율적인 데이터 관리
```javascript
// 데이터 라이프사이클 관리
const manageDataLifecycle = async () => {
  // 오래된 대화 기록 정리
  const oldConversations = await getOldConversations(90); // 90일 이전
  for (const conv of oldConversations) {
    await deleteConversation(conv.id);
  }
  
  // 사용하지 않는 문서 아카이브
  const unusedDocs = await getUnusedDocuments(180); // 180일 미사용
  for (const doc of unusedDocs) {
    await archiveDocument(doc.id);
  }
};
```

### 10.2 쿼리 최적화
```javascript
// 비용 효율적인 쿼리 패턴
const optimizeQueryCost = (query) => {
  // 너무 일반적인 쿼리는 구체화 요청
  if (query.length < 10) {
    return {
      optimized: false,
      suggestion: "더 구체적인 검색어를 입력해주세요."
    };
  }
  
  // 자주 검색되는 패턴은 캐시 활용
  const commonPatterns = ['회의', '프레젠테이션', '보고서'];
  const hasCommonPattern = commonPatterns.some(pattern => 
    query.includes(pattern));
  
  return {
    optimized: true,
    useCache: hasCommonPattern,
    estimatedCost: calculateQueryCost(query)
  };
};
```