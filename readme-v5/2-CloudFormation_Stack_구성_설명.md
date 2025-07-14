# Media2Cloud v5 CloudFormation Stack 구성 설명

## 1. 전체 스택 아키텍처

Media2Cloud v5는 여러 개의 중첩된 CloudFormation 스택으로 구성되어 있으며, 각 스택은 특정 기능과 리소스를 담당합니다.

### 1.1 스택 계층 구조
```
메인 스택 (media2cloud_v5.template)
├── 코어 스택 (Core Stack)
├── 웹앱 스택 (WebApp Stack)  
├── 백엔드 스택 (Backend Stack)
├── CodeBuild 스택 (CodeBuild Stack)
├── Knowledge Graph 스택 (Graph Stack) - 선택사항
└── Amazon Q 통합 스택 (AmazonQ Stack) - 선택사항
```

## 2. 메인 스택 (media2cloud_v5.template)

### 2.1 주요 역할
- 전체 솔루션의 오케스트레이션
- 하위 스택들의 생성 및 관리
- 스택 간 의존성 관리
- 공통 파라미터 및 설정 관리

### 2.2 주요 파라미터

#### 필수 파라미터
- **Email**: Cognito 사용자 및 SNS 구독용 이메일
- **VersionCompatibilityStatement**: 버전 호환성 확인
- **FFmpegAgreeAndProceed**: FFmpeg 라이선스 동의

#### 선택적 파라미터
- **UserDefinedIngestBucket**: 기존 S3 버킷 사용 시
- **OpenSearchCluster**: OpenSearch 클러스터 크기 설정
- **DefaultAIOptions**: AI/ML 분석 기능 선택
- **EnableKnowledgeGraph**: Knowledge Graph 기능 활성화
- **AmazonQBucket**: Amazon Q Business 연동 버킷
- **HuggingFaceToken**: Pyannote Audio 모델용 토큰

### 2.3 주요 리소스

#### Custom Resources
```yaml
CustomResourcesLambda:
  Type: AWS::Lambda::Function
  Properties:
    FunctionName: !Sub ${solutionId}-${stackId}-custom-resources
    Runtime: nodejs20.x
    Handler: index.handler
    Code:
      S3Bucket: !Sub ${bucket}${region}
      S3Key: !Sub ${keyprefix}/${package}
```

#### Application Registry
```yaml
Application:
  Type: AWS::ServiceCatalogAppRegistry::Application
  Properties:
    Name: !Join ["-", [Media2CloudOnAws, !Ref AWS::Region, !Ref AWS::AccountId]]
    Tags:
      Solutions:SolutionID: SO0050
      Solutions:SolutionVersion: v5.20240530.3
```

## 3. 코어 스택 (Core Stack)

### 3.1 주요 역할
- 기본 인프라 리소스 생성
- 공유 리소스 관리 (S3 버킷, Lambda Layer 등)
- OpenSearch 클러스터 구성
- IoT Core 설정

### 3.2 주요 리소스

#### S3 버킷
- **Ingest Bucket**: 원본 미디어 파일 업로드
- **Proxy Bucket**: 처리된 파일 및 메타데이터 저장
- **Web Bucket**: 웹 애플리케이션 호스팅

#### Lambda Layers
- **AWS SDK Layer**: AWS SDK 공통 라이브러리
- **Core Library Layer**: 솔루션 공통 라이브러리
- **Tokenizer Layer**: 텍스트 토크나이저

#### OpenSearch 설정
```yaml
OpenSearchDomain:
  Type: AWS::OpenSearch::Domain
  Properties:
    DomainName: !Sub ${ResourcePrefix}-opensearch
    EngineVersion: OpenSearch_2.3
    ClusterConfig:
      InstanceType: !Ref OpenSearchInstance
      InstanceCount: !Ref OpenSearchInstanceCount
```

#### IoT Core
- **IoT Thing Policy**: 디바이스 정책
- **IoT Topic**: 실시간 상태 업데이트용 토픽

## 4. 웹앱 스택 (WebApp Stack)

### 4.1 주요 역할
- 웹 인터페이스 구성
- API Gateway 설정
- Cognito 사용자 인증
- CloudFront 배포

### 4.2 주요 리소스

#### API Gateway
```yaml
RestApi:
  Type: AWS::ApiGateway::RestApi
  Properties:
    Name: !Sub ${ResourcePrefix}-api
    EndpointConfiguration:
      Types: [REGIONAL]
```

#### Cognito 설정
- **User Pool**: 사용자 인증 풀
- **Identity Pool**: 자격 증명 풀
- **User Groups**: Admin, Creator, Viewer 그룹

#### CloudFront 배포
```yaml
CloudFrontDistribution:
  Type: AWS::CloudFront::Distribution
  Properties:
    DistributionConfig:
      Origins:
        - DomainName: !GetAtt WebBucket.RegionalDomainName
          Id: S3Origin
```

## 5. 백엔드 스택 (Backend Stack)

### 5.1 주요 역할
- Lambda 함수 배포
- Step Functions 워크플로우 생성
- DynamoDB 테이블 구성
- SNS 토픽 설정

### 5.2 주요 리소스

#### Lambda 함수들
- **Main S3 Event**: S3 이벤트 처리
- **Ingest Main**: 수집 워크플로우 메인
- **Analysis Main**: 분석 워크플로우 메인
- **API Handler**: REST API 처리
- **각종 분석 함수들**: 비디오, 오디오, 이미지, 문서 분석

#### Step Functions
- **Main State Machine**: 메인 워크플로우
- **Ingest State Machine**: 수집 워크플로우
- **Analysis State Machine**: 분석 워크플로우
- **각 미디어 타입별 워크플로우**

#### DynamoDB 테이블
- **Ingest Table**: 수집 데이터 저장
- **Analysis Table**: 분석 결과 저장
- **Face Indexer Table**: 얼굴 인식 인덱스

## 6. CodeBuild 스택 (CodeBuild Stack)

### 6.1 주요 역할
- ECR 컨테이너 이미지 빌드
- Docker 이미지 관리
- 모델 아티팩트 다운로드

### 6.2 주요 리소스

#### ECR 리포지토리
```yaml
ECRRepository:
  Type: AWS::ECR::Repository
  Properties:
    RepositoryName: !Sub ${ResourcePrefix}-${ImageName}
    ImageScanningConfiguration:
      ScanOnPush: true
```

#### CodeBuild 프로젝트
- **FAISS 이미지 빌드**
- **WhisperX 이미지 빌드**
- **PyannoteAudio 이미지 빌드**
- **FaceAPI 이미지 빌드**
- **기타 ML 모델 이미지들**

## 7. Knowledge Graph 스택 (선택사항)

### 7.1 주요 역할
- Amazon Neptune Serverless 구성
- VPC 및 네트워킹 설정
- 관계형 데이터 시각화

### 7.2 주요 리소스
- **Neptune Serverless Cluster**
- **VPC 및 서브넷**
- **API Gateway (Graph API)**
- **Lambda 함수 (Graph 처리)**

## 8. Amazon Q 통합 스택 (선택사항)

### 8.1 주요 역할
- Amazon Q Business 연동
- 메타데이터 동기화
- 대화형 검색 인터페이스

### 8.2 주요 리소스
- **S3 동기화 Lambda**
- **EventBridge 규칙**
- **Step Functions (Q 통합)**

## 9. 스택 배포 순서

### 9.1 의존성 순서
```
1. Custom Resources 생성
2. Core Stack 배포
3. CodeBuild Stack 배포 (ECR 이미지 빌드)
4. Backend Stack 배포
5. WebApp Stack 배포
6. Knowledge Graph Stack 배포 (선택사항)
7. Amazon Q Stack 배포 (선택사항)
8. 후처리 작업 (사용자 등록, SNS 구독 등)
```

### 9.2 배포 시간
- **전체 배포**: 약 30-45분
- **ECR 이미지 빌드**: 약 15-20분
- **OpenSearch 클러스터**: 약 10-15분

## 10. 스택 관리

### 10.1 업데이트 전략
- **Rolling Update**: 무중단 업데이트 지원
- **Blue/Green**: 중요 업데이트 시 사용
- **Rollback**: 자동 롤백 지원

### 10.2 모니터링
- **CloudFormation Events**: 스택 이벤트 모니터링
- **CloudWatch**: 리소스 메트릭 모니터링
- **AWS Config**: 리소스 구성 추적

## 11. 보안 설정

### 11.1 IAM 역할 및 정책
- **최소 권한 원칙**: 각 리소스별 최소 권한 부여
- **Cross-Stack References**: 스택 간 안전한 리소스 참조
- **Service-Linked Roles**: AWS 서비스별 역할 자동 생성

### 11.2 네트워크 보안
- **VPC 설정**: Knowledge Graph용 VPC
- **보안 그룹**: 포트 및 프로토콜 제한
- **NAT Gateway**: 아웃바운드 트래픽 제어

## 12. 문제 해결

### 12.1 일반적인 배포 오류
- **권한 부족**: IAM 권한 확인
- **리소스 한도**: AWS 서비스 한도 확인
- **네트워크 설정**: VPC 및 서브넷 구성 확인

### 12.2 롤백 시나리오
- **자동 롤백**: CloudFormation 자동 롤백 기능
- **수동 롤백**: 특정 스택만 롤백
- **데이터 백업**: 중요 데이터 사전 백업