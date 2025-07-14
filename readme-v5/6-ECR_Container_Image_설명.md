# Media2Cloud v5 ECR Container Image 설명

## 1. ECR 컨테이너 개요

Media2Cloud v5는 고급 AI/ML 기능을 위해 여러 ECR(Elastic Container Registry) 컨테이너 이미지를 활용합니다. 이러한 컨테이너들은 Lambda에서 실행되어 전문적인 미디어 분석 작업을 수행합니다.

### 1.1 컨테이너 아키텍처
```
Lambda Function (Container Runtime)
├── ECR Image Pull
├── Model Loading
├── Processing
└── Result Upload to S3
```

### 1.2 지원되는 컨테이너 목록
- **WhisperX**: 고급 음성 인식 및 화자 분리
- **PyannoteAudio**: 음성 분할 및 화자 다이어리제이션
- **FaceAPI**: 얼굴 감지 및 분석
- **FaceNet**: 얼굴 임베딩 생성
- **DeepFilterNet**: 오디오 노이즈 제거
- **AudiosetTagging**: 오디오 분류 및 태깅
- **FAISS**: 벡터 유사도 검색
- **Model Downloader**: ML 모델 다운로드 및 관리

## 2. WhisperX 컨테이너

### 2.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/whisperx-on-aws:0.1.17`
- **기반 모델**: OpenAI Whisper + WhisperX 확장
- **주요 기능**: 고정밀 음성 인식, 화자 분리, 타임스탬프 정렬

### 2.2 주요 기능
```python
# WhisperX 처리 예시
import whisperx

# 모델 로드
model = whisperx.load_model("large-v2", device="cpu")
diarize_model = whisperx.DiarizationPipeline(use_auth_token=hf_token)

# 음성 인식
result = model.transcribe(audio_file)

# 화자 분리
diarize_segments = diarize_model(audio_file)
result = whisperx.assign_word_speakers(diarize_segments, result)
```

### 2.3 지원 언어
- **다국어 지원**: 99개 언어 자동 감지
- **한국어 최적화**: 한국어 특화 모델 지원
- **코드 스위칭**: 다국어 혼재 음성 처리

### 2.4 출력 형식
```json
{
  "segments": [
    {
      "start": 0.0,
      "end": 5.2,
      "text": "안녕하세요, 반갑습니다.",
      "speaker": "SPEAKER_00",
      "words": [
        {
          "word": "안녕하세요",
          "start": 0.0,
          "end": 1.5,
          "score": 0.95
        }
      ]
    }
  ],
  "language": "ko"
}
```

## 3. PyannoteAudio 컨테이너

### 3.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/pyannote-on-aws:0.2.16`
- **기반 모델**: pyannote.audio 3.x
- **주요 기능**: 화자 다이어리제이션, 음성 활동 감지, 화자 임베딩

### 3.2 주요 기능
```python
# Pyannote 처리 예시
from pyannote.audio import Pipeline

# 파이프라인 로드 (HuggingFace 토큰 필요)
pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1",
    use_auth_token=hf_token
)

# 화자 분리 실행
diarization = pipeline(audio_file)

# 결과 처리
for turn, _, speaker in diarization.itertracks(yield_label=True):
    print(f"Speaker {speaker}: {turn.start:.1f}s - {turn.end:.1f}s")
```

### 3.3 모델 구성
- **Segmentation Model**: 음성 구간 감지
- **Embedding Model**: 화자 특성 추출
- **Clustering**: 화자별 그룹핑

### 3.4 성능 특징
- **정확도**: 업계 최고 수준의 화자 분리 정확도
- **실시간 처리**: 스트리밍 오디오 지원
- **다양한 환경**: 노이즈, 에코 환경에서도 안정적 동작

## 4. FaceAPI 컨테이너

### 4.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/faceapi-on-aws:5.0.1`
- **기반 라이브러리**: face-api.js
- **주요 기능**: 얼굴 감지, 표정 분석, 나이/성별 추정

### 4.2 주요 기능
```javascript
// FaceAPI 처리 예시
const faceapi = require('face-api.js');

// 모델 로드
await faceapi.nets.tinyFaceDetector.loadFromDisk('./models');
await faceapi.nets.faceExpressionNet.loadFromDisk('./models');
await faceapi.nets.ageGenderNet.loadFromDisk('./models');

// 얼굴 분석
const detections = await faceapi
  .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions())
  .withFaceExpressions()
  .withAgeAndGender();
```

### 3.3 분석 결과
```json
{
  "faces": [
    {
      "detection": {
        "box": {"x": 100, "y": 150, "width": 80, "height": 100},
        "score": 0.95
      },
      "expressions": {
        "happy": 0.8,
        "sad": 0.1,
        "angry": 0.05,
        "surprised": 0.05
      },
      "ageAndGender": {
        "age": 25,
        "gender": "female",
        "genderProbability": 0.9
      }
    }
  ]
}
```

### 4.4 최적화 특징
- **경량 모델**: TinyFaceDetector 사용으로 빠른 처리
- **배치 처리**: 다중 이미지 동시 처리
- **GPU 가속**: CUDA 지원 (선택사항)

## 5. FaceNet 컨테이너

### 5.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/facenet-pytorch-on-aws:0.0.10`
- **기반 모델**: FaceNet PyTorch 구현
- **주요 기능**: 얼굴 임베딩 생성, 얼굴 유사도 계산

### 5.2 주요 기능
```python
# FaceNet 처리 예시
from facenet_pytorch import MTCNN, InceptionResnetV1

# 모델 로드
mtcnn = MTCNN(image_size=160, margin=0)
resnet = InceptionResnetV1(pretrained='vggface2').eval()

# 얼굴 임베딩 생성
face_tensor = mtcnn(image)
embedding = resnet(face_tensor.unsqueeze(0))
```

### 5.3 임베딩 특징
- **차원**: 512차원 벡터
- **정규화**: L2 정규화 적용
- **유사도**: 코사인 유사도 계산

### 5.4 활용 사례
- **얼굴 검색**: 유사한 얼굴 찾기
- **얼굴 클러스터링**: 동일 인물 그룹핑
- **얼굴 매칭**: 신원 확인

## 6. DeepFilterNet 컨테이너

### 6.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/deepfilternet-on-aws:0.0.3`
- **기반 모델**: DeepFilterNet 3.0
- **주요 기능**: 실시간 오디오 노이즈 제거

### 6.2 주요 기능
```python
# DeepFilterNet 처리 예시
from df import enhance, init_df

# 모델 초기화
model, df_state, _ = init_df()

# 노이즈 제거
enhanced_audio = enhance(model, df_state, noisy_audio)
```

### 6.3 노이즈 제거 성능
- **실시간 처리**: 저지연 처리 가능
- **다양한 노이즈**: 배경 소음, 에코, 바람 소리 등
- **음성 보존**: 원본 음성 품질 유지

### 6.4 적용 분야
- **음성 인식 전처리**: 인식 정확도 향상
- **오디오 품질 개선**: 청취 경험 향상
- **방송 후처리**: 전문적인 오디오 정리

## 7. AudiosetTagging 컨테이너

### 7.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/audioset-tagging-on-aws:0.0.5`
- **기반 모델**: Google AudioSet 기반 분류 모델
- **주요 기능**: 오디오 이벤트 분류 및 태깅

### 7.2 주요 기능
```python
# AudioSet Tagging 처리 예시
import audioset_tagging

# 모델 로드
model = audioset_tagging.load_model()

# 오디오 분류
predictions = model.predict(audio_features)
tags = audioset_tagging.get_top_tags(predictions, top_k=10)
```

### 7.3 분류 카테고리
- **음악**: 악기, 장르, 리듬
- **음성**: 말하기, 노래, 웃음
- **자연음**: 동물, 날씨, 물소리
- **인공음**: 기계, 차량, 알람

### 7.4 출력 형식
```json
{
  "predictions": [
    {
      "label": "Music",
      "score": 0.85,
      "start_time": 0.0,
      "end_time": 10.0
    },
    {
      "label": "Speech",
      "score": 0.72,
      "start_time": 5.0,
      "end_time": 15.0
    }
  ]
}
```

## 8. FAISS 컨테이너

### 8.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/faiss-on-aws:0.1.12`
- **기반 라이브러리**: Facebook AI Similarity Search
- **주요 기능**: 고속 벡터 유사도 검색

### 8.2 주요 기능
```python
# FAISS 처리 예시
import faiss
import numpy as np

# 인덱스 생성
dimension = 512
index = faiss.IndexFlatIP(dimension)  # Inner Product

# 벡터 추가
vectors = np.random.random((1000, dimension)).astype('float32')
index.add(vectors)

# 유사도 검색
query_vector = np.random.random((1, dimension)).astype('float32')
distances, indices = index.search(query_vector, k=10)
```

### 8.3 인덱스 타입
- **Flat**: 정확한 검색, 소규모 데이터
- **IVF**: 클러스터 기반, 대규모 데이터
- **HNSW**: 그래프 기반, 고속 검색

### 8.4 활용 사례
- **이미지 유사도 검색**: 비슷한 이미지 찾기
- **얼굴 검색**: 얼굴 임베딩 기반 검색
- **콘텐츠 추천**: 유사 콘텐츠 추천

## 9. Model Downloader 컨테이너

### 9.1 기본 정보
- **이미지 URI**: `189427507247.dkr.ecr.us-west-2.amazonaws.com/model-downloader:latest`
- **주요 기능**: ML 모델 다운로드 및 S3 업로드

### 9.2 지원 모델 소스
- **HuggingFace Hub**: Transformers 모델
- **PyTorch Hub**: PyTorch 모델
- **TensorFlow Hub**: TensorFlow 모델
- **Custom URLs**: 직접 다운로드

### 9.3 다운로드 프로세스
```python
# 모델 다운로드 예시
def download_model(model_name, model_source):
    if model_source == 'huggingface':
        model = transformers.AutoModel.from_pretrained(model_name)
        model.save_pretrained(f'/tmp/{model_name}')
    
    # S3 업로드
    upload_to_s3(f'/tmp/{model_name}', bucket, key)
```

## 10. 컨테이너 관리 및 배포

### 10.1 CodeBuild 통합
```yaml
# buildspec.yml 예시
version: 0.2
phases:
  pre_build:
    commands:
      - echo Logging in to Amazon ECR...
      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com
  build:
    commands:
      - echo Build started on `date`
      - docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .
      - docker tag $IMAGE_REPO_NAME:$IMAGE_TAG $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
  post_build:
    commands:
      - docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG
```

### 10.2 버전 관리
- **시맨틱 버전**: Major.Minor.Patch 형식
- **태그 전략**: latest, stable, version-specific
- **롤백 지원**: 이전 버전으로 자동 롤백

### 10.3 보안 스캔
- **취약점 스캔**: ECR 자동 스캔 활성화
- **이미지 서명**: Docker Content Trust
- **최소 권한**: 컨테이너 실행 권한 최소화

## 11. 성능 최적화

### 11.1 이미지 크기 최적화
```dockerfile
# Multi-stage build 예시
FROM python:3.9-slim as builder
COPY requirements.txt .
RUN pip install --user -r requirements.txt

FROM python:3.9-slim
COPY --from=builder /root/.local /root/.local
COPY . .
CMD ["python", "app.py"]
```

### 11.2 캐싱 전략
- **Layer 캐싱**: Docker layer 재사용
- **모델 캐싱**: 자주 사용되는 모델 사전 로드
- **의존성 캐싱**: pip/npm 캐시 활용

### 11.3 Lambda 최적화
- **프로비저닝된 동시성**: 콜드 스타트 제거
- **메모리 할당**: 모델 크기에 맞는 메모리 설정
- **타임아웃 설정**: 처리 시간에 맞는 타임아웃

## 12. 모니터링 및 로깅

### 12.1 컨테이너 메트릭
- **CPU/메모리 사용률**: CloudWatch 메트릭
- **실행 시간**: 처리 시간 추적
- **오류율**: 실패한 실행 비율

### 12.2 로그 관리
```python
import logging

# 구조화된 로깅
logger = logging.getLogger(__name__)
logger.info({
    "event": "model_inference",
    "model": "whisperx",
    "duration": 15.2,
    "input_size": "10MB"
})
```

### 12.3 알림 설정
- **오류 알림**: 실행 실패 시 SNS 알림
- **성능 알림**: 처리 시간 임계값 초과 시
- **리소스 알림**: 메모리/CPU 사용률 높을 때

