# Media2Cloud API Resource별 Operation 동작 분석

## 1. AssetOp (자산 관리)

### GET 요청
- **단일 자산 조회**: `/assets/{uuid}` → DynamoDB에서 자산 정보 조회
- **자산 목록 조회**: `/assets` → 페이지네이션 지원
  - `overallStatus` 필터: 상태별 자산 조회
  - `type` 필터: 타입별 자산 조회
  - 전체 자산 조회 (기본)

### POST 요청
- **워크플로우 시작**: Step Functions Main State Machine 실행
- **배치 처리**: JSON 파일인 경우 여러 파일 동시 처리
- **입력 검증**: UUID, 버킷명, 속성 키/값 검증
- **S3 객체 존재 확인** 후 워크플로우 시작

### DELETE 요청
- **자산 삭제**: Asset Removal State Machine 실행
- UUID 검증 후 삭제 워크플로우 시작

## 2. AnalysisOp (분석 결과 관리)

### GET 요청
- **분석 결과 조회**: 여러 분석 타입 결과를 병렬로 조회
- **Shoppable 데이터 통합**: 비디오 분석 시 쇼핑 가능 정보 추가
- DynamoDB에서 분석 타입별 결과 조회

### POST 요청
- **재분석 시작**: AI/ML 옵션 변경 후 재분석
- **워크플로우 선택**: 
  - 수집 필요 시 → Main State Machine
  - 분석만 필요 시 → Analysis State Machine
- 기존 분석 결과 삭제 후 새로운 분석 시작

### DELETE 요청
- **분석 결과 삭제**: DynamoDB에서 analysis 컬럼 삭제

## 3. SearchOp (검색 기능)

### GET 요청
- **복합 검색**: OpenSearch에서 AND, OR, NOT 연산자 지원
- **Base64 디코딩**: 검색어 Base64 인코딩 지원
- **미디어 타입 필터링**: video, audio, image, document 필터
- **하이라이트 기능**: 검색 결과에 매칭 부분 강조
- **페이지네이션**: from/size 기반 페이지네이션

### POST/DELETE 요청
- **미구현**: 검색은 GET 요청만 지원

## 4. GenAIOp (생성형 AI)

### POST 요청
- **토큰화**: 텍스트를 토큰으로 분할
- **AI 추론**: Claude 모델을 통한 다양한 분석
  - 장르 분석, 감정 분석, 요약 생성
  - 분류 체계, 주제 분석, TV 등급 분석
- **모델 검증**: 지원되는 모델인지 확인
- **입력 검증**: model, prompt, text_inputs 필수

### GET/DELETE 요청
- **미구현**: 생성형 AI는 POST 요청만 지원

## 5. FaceIndexerOp (얼굴 인덱서)

### GET 요청
- **컬렉션별 얼굴 조회**: Rekognition + FaceIndexer 테이블 데이터 병합
- **배치 얼굴 조회**: 여러 faceId 동시 조회
- **단일 얼굴 조회**: 특정 faceId 상세 정보

### POST 요청
- **얼굴 태깅 업데이트**: 배치 업데이트 후 워크플로우 시작
- **얼굴 인덱싱**: 
  - JSON 파일 → 배치 인덱싱 워크플로우
  - 단일 이미지 → 즉시 인덱싱
- **얼굴 가져오기**: 기존 컬렉션에서 얼굴 데이터 가져오기

### DELETE 요청
- **얼굴 삭제**: FaceIndexer 관리 또는 Rekognition 직접 삭제

## 6. SearchOp (검색 기능) - 상세

### 검색 처리 흐름
1. **쿼리 정제**: Base64 디코딩 → URL 디코딩 → 문자셋 검증
2. **복합 쿼리 구성**: OpenSearch query_string 쿼리 생성
3. **검색 실행**: OpenSearch에서 검색 수행
4. **결과 파싱**: 하이라이트 정보 추출
5. **상세 정보 조회**: mget API로 추가 정보 조회

## 7. SettingsOp (설정 관리)

### GET 요청
- **AI 옵션 조회**: S3에서 글로벌 설정 조회
- **기본값 반환**: 설정이 없으면 환경 변수 기본값 사용

### POST 요청
- **AI 옵션 저장**: S3에 JSON 형태로 설정 저장

### DELETE 요청
- **AI 옵션 삭제**: S3에서 설정 파일 삭제

## 8. StatsOp (통계)

### GET 요청
- **전체 통계**: 수집 통계 + 최근 자산 목록
- **집계 검색**: 특정 필드별 집계 통계
- **OpenSearch 집계**: 타입별, 상태별 통계 생성

### POST/DELETE 요청
- **미구현**: 통계는 조회만 지원

## 9. StepOp (Step Functions 실행 상태)

### GET 요청
- **실행 상태 조회**: Step Functions 실행 ARN으로 상태 조회
- **상세 정보**: 입력, 출력, 에러, 원인 정보 포함
- **ARN 검증**: State Machine ARN 형식 검증

### POST/DELETE 요청
- **미구현**: 실행 상태는 조회만 지원

## 10. IotOp (IoT 정책 연결)

### POST 요청
- **정책 연결**: Cognito Identity ID에 IoT 정책 연결
- **사용자 인증**: Cognito Identity ID 필수

### GET/DELETE 요청
- **미구현**: IoT는 정책 연결만 지원

## 11. UsersOp (사용자 관리)

### GET 요청
- **사용자 목록**: Cognito User Pool에서 사용자 목록 조회
- **그룹 정보**: 각 사용자의 그룹 정보 포함
- **페이지네이션**: Cognito 페이지네이션 지원

### POST 요청
- **사용자 생성**: 
  - 이메일 검증 → 사용자명 생성 → Cognito 사용자 생성
  - 그룹 할당 → 이메일 초대 발송

### DELETE 요청
- **사용자 삭제**: Cognito에서 사용자 삭제

## 12. TranscribeOp (Transcribe 리소스)

### GET 요청
- **커스텀 언어 모델**: COMPLETED 상태의 모델 목록
- **커스텀 어휘**: READY 상태의 어휘 목록
- **페이지네이션**: AWS API 페이지네이션 지원

### POST/DELETE 요청
- **미구현**: 리소스 조회만 지원

## 13. ComprehendOp (Comprehend 리소스)

### GET 요청
- **커스텀 엔티티 인식기**: TRAINED 상태의 인식기 목록
- **ARN 파싱**: 리소스 이름 추출
- **페이지네이션**: AWS API 페이지네이션 지원

### POST/DELETE 요청
- **미구현**: 리소스 조회만 지원

## 14. RekognitionOp (Rekognition 리소스)

### GET 요청
- **얼굴 컬렉션**: 컬렉션 목록 및 상세 정보
- **커스텀 라벨 모델**: 사용 가능한 프로젝트 버전 목록
- **프로젝트 상태 확인**: 실행 가능한 버전만 필터링

### POST 요청
- **컬렉션 생성**: 새로운 얼굴 컬렉션 생성

### DELETE 요청
- **컬렉션 삭제**: 기존 얼굴 컬렉션 삭제

## 공통 특징

### 에러 처리
- **표준화된 에러 응답**: BaseOp에서 통일된 에러 형식
- **HTTP 200 응답**: 에러도 200 상태코드로 반환
- **상세 에러 정보**: 에러 코드, 이름, 메시지 포함

### CORS 지원
- **자동 CORS 헤더**: 모든 응답에 CORS 헤더 자동 추가
- **OPTIONS 메서드**: 프리플라이트 요청 지원

### 입력 검증
- **UUID 검증**: CommonUtils를 통한 UUID 형식 검증
- **이메일 검증**: 이메일 주소 형식 검증
- **ARN 검증**: AWS 리소스 ARN 형식 검증

### AWS 서비스 통합
- **X-Ray 추적**: 모든 AWS SDK 호출에 X-Ray 추적
- **재시도 전략**: 지수 백오프 재시도 전략 적용
- **커스텀 User-Agent**: 솔루션 식별을 위한 커스텀 헤더