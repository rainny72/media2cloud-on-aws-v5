# Media2Cloud v5 OpenSearch 메타데이터 인덱싱 및 검색 구성

## 1. OpenSearch 개요

Media2Cloud v5는 Amazon OpenSearch Service를 사용하여 미디어 메타데이터의 인덱싱과 고급 검색 기능을 제공합니다. 모든 분석 결과와 메타데이터가 OpenSearch에 저장되어 실시간 검색이 가능합니다.

### 1.1 OpenSearch 아키텍처
```
Media Processing → Analysis Results → OpenSearch Indexing → Search API
                                   ↓
                              Document Store
                              ├── Ingest Index
                              ├── Analysis Index  
                              ├── Face Index
                              └── Custom Indices
```

### 1.2 주요 기능
- **전문 검색**: 텍스트 기반 고급 검색
- **패싯 검색**: 카테고리별 필터링
- **지리적 검색**: 위치 기반 검색
- **시간 범위 검색**: 날짜/시간 기반 검색
- **유사도 검색**: 벡터 기반 유사도 검색

## 2. 클러스터 구성

### 2.1 클러스터 옵션
Media2Cloud v5는 다양한 환경에 맞는 클러스터 구성을 제공합니다:

#### 개발/테스트 환경
```yaml
ClusterConfig:
  InstanceType: t3.medium
  InstanceCount: 1
  DedicatedMasterEnabled: false
  MasterInstanceType: null
  MasterInstanceCount: 0
EBSOptions:
  EBSEnabled: true
  VolumeType: gp2
  VolumeSize: 10
```

#### 운영 환경 (소규모)
```yaml
ClusterConfig:
  InstanceType: m5.large
  InstanceCount: 2
  DedicatedMasterEnabled: true
  MasterInstanceType: t3.medium
  MasterInstanceCount: 3
EBSOptions:
  VolumeType: gp2
  VolumeSize: 20
```

#### 운영 환경 (대규모)
```yaml
ClusterConfig:
  InstanceType: m5.large
  InstanceCount: 6
  DedicatedMasterEnabled: true
  MasterInstanceType: t3.medium
  MasterInstanceCount: 3
EBSOptions:
  VolumeType: gp2
  VolumeSize: 40
```

### 2.2 OpenSearch Serverless 옵션
```yaml
# Serverless 구성 (선택사항)
OpenSearchServerless:
  CollectionName: media2cloud-collection
  Type: SEARCH
  SecurityPolicy: 
    Type: encryption
    Rules:
      - ResourceType: collection
        Resource: collection/media2cloud-collection
```

## 3. 인덱스 구조

### 3.1 메인 인덱스 (media2cloud-ingest)

#### 인덱스 매핑
```json
{
  "mappings": {
    "properties": {
      "uuid": {
        "type": "keyword"
      },
      "timestamp": {
        "type": "date",
        "format": "epoch_millis"
      },
      "type": {
        "type": "keyword"
      },
      "bucket": {
        "type": "keyword"
      },
      "key": {
        "type": "text",
        "fields": {
          "keyword": {
            "type": "keyword"
          }
        }
      },
      "fileSize": {
        "type": "long"
      },
      "duration": {
        "type": "float"
      },
      "overallStatus": {
        "type": "keyword"
      }
    }
  }
}
```

#### 비디오 메타데이터 매핑
```json
{
  "properties": {
    "video": {
      "properties": {
        "width": {"type": "integer"},
        "height": {"type": "integer"},
        "frameRate": {"type": "float"},
        "bitRate": {"type": "long"},
        "codec": {"type": "keyword"},
        "profile": {"type": "keyword"},
        "level": {"type": "keyword"}
      }
    },
    "audio": {
      "properties": {
        "channels": {"type": "integer"},
        "sampleRate": {"type": "integer"},
        "bitRate": {"type": "long"},
        "codec": {"type": "keyword"}
      }
    }
  }
}
```

### 3.2 분석 결과 인덱스 (media2cloud-analysis)

#### Rekognition 결과 매핑
```json
{
  "properties": {
    "rekognition": {
      "properties": {
        "celeb": {
          "properties": {
            "celebrities": {
              "type": "nested",
              "properties": {
                "name": {"type": "text"},
                "confidence": {"type": "float"},
                "timestamp": {"type": "float"},
                "boundingBox": {
                  "properties": {
                    "width": {"type": "float"},
                    "height": {"type": "float"},
                    "left": {"type": "float"},
                    "top": {"type": "float"}
                  }
                }
              }
            }
          }
        },
        "labels": {
          "type": "nested",
          "properties": {
            "name": {"type": "text"},
            "confidence": {"type": "float"},
            "timestamp": {"type": "float"},
            "parents": {
              "type": "nested",
              "properties": {
                "name": {"type": "text"}
              }
            }
          }
        }
      }
    }
  }
}
```

#### Transcribe 결과 매핑
```json
{
  "properties": {
    "transcribe": {
      "properties": {
        "transcript": {
          "type": "text",
          "analyzer": "standard"
        },
        "segments": {
          "type": "nested",
          "properties": {
            "startTime": {"type": "float"},
            "endTime": {"type": "float"},
            "text": {"type": "text"},
            "speaker": {"type": "keyword"},
            "confidence": {"type": "float"}
          }
        },
        "speakers": {
          "type": "nested",
          "properties": {
            "speaker": {"type": "keyword"},
            "duration": {"type": "float"}
          }
        }
      }
    }
  }
}
```

#### Comprehend 결과 매핑
```json
{
  "properties": {
    "comprehend": {
      "properties": {
        "entities": {
          "type": "nested",
          "properties": {
            "text": {"type": "text"},
            "type": {"type": "keyword"},
            "score": {"type": "float"},
            "beginOffset": {"type": "integer"},
            "endOffset": {"type": "integer"}
          }
        },
        "keyPhrases": {
          "type": "nested",
          "properties": {
            "text": {"type": "text"},
            "score": {"type": "float"},
            "beginOffset": {"type": "integer"},
            "endOffset": {"type": "integer"}
          }
        },
        "sentiment": {
          "properties": {
            "sentiment": {"type": "keyword"},
            "positive": {"type": "float"},
            "negative": {"type": "float"},
            "neutral": {"type": "float"},
            "mixed": {"type": "float"}
          }
        }
      }
    }
  }
}
```

### 3.3 얼굴 인덱스 (media2cloud-faces)
```json
{
  "mappings": {
    "properties": {
      "uuid": {"type": "keyword"},
      "faceId": {"type": "keyword"},
      "collectionId": {"type": "keyword"},
      "confidence": {"type": "float"},
      "boundingBox": {
        "properties": {
          "width": {"type": "float"},
          "height": {"type": "float"},
          "left": {"type": "float"},
          "top": {"type": "float"}
        }
      },
      "attributes": {
        "properties": {
          "gender": {"type": "keyword"},
          "ageRange": {
            "properties": {
              "low": {"type": "integer"},
              "high": {"type": "integer"}
            }
          },
          "emotions": {
            "type": "nested",
            "properties": {
              "type": {"type": "keyword"},
              "confidence": {"type": "float"}
            }
          }
        }
      },
      "embedding": {
        "type": "dense_vector",
        "dims": 512
      }
    }
  }
}
```

## 4. 인덱싱 프로세스

### 4.1 실시간 인덱싱
```javascript
// Lambda 함수에서 OpenSearch 인덱싱
const indexDocument = async (index, document) => {
  const client = new Client({
    node: process.env.OPENSEARCH_ENDPOINT,
    auth: {
      username: 'admin',
      password: 'admin'
    }
  });

  const response = await client.index({
    index: index,
    id: document.uuid,
    body: document,
    refresh: true
  });

  return response;
};
```

### 4.2 배치 인덱싱
```javascript
// 대량 문서 배치 인덱싱
const bulkIndex = async (index, documents) => {
  const body = documents.flatMap(doc => [
    { index: { _index: index, _id: doc.uuid } },
    doc
  ]);

  const response = await client.bulk({
    refresh: true,
    body: body
  });

  return response;
};
```

### 4.3 인덱스 템플릿
```json
{
  "index_patterns": ["media2cloud-*"],
  "template": {
    "settings": {
      "number_of_shards": 1,
      "number_of_replicas": 1,
      "analysis": {
        "analyzer": {
          "media_analyzer": {
            "type": "custom",
            "tokenizer": "standard",
            "filter": [
              "lowercase",
              "stop",
              "snowball"
            ]
          }
        }
      }
    },
    "mappings": {
      "dynamic_templates": [
        {
          "strings": {
            "match_mapping_type": "string",
            "mapping": {
              "type": "text",
              "fields": {
                "keyword": {
                  "type": "keyword",
                  "ignore_above": 256
                }
              }
            }
          }
        }
      ]
    }
  }
}
```

## 5. 검색 기능

### 5.1 기본 텍스트 검색
```javascript
// 전문 검색
const searchText = async (query, index = 'media2cloud-*') => {
  const searchParams = {
    index: index,
    body: {
      query: {
        multi_match: {
          query: query,
          fields: [
            'transcribe.transcript^2',
            'comprehend.keyPhrases.text',
            'rekognition.labels.name',
            'key'
          ],
          type: 'best_fields',
          fuzziness: 'AUTO'
        }
      },
      highlight: {
        fields: {
          'transcribe.transcript': {},
          'comprehend.keyPhrases.text': {}
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

### 5.2 필터 검색
```javascript
// 복합 필터 검색
const searchWithFilters = async (filters) => {
  const must = [];
  const filter = [];

  // 텍스트 쿼리
  if (filters.query) {
    must.push({
      multi_match: {
        query: filters.query,
        fields: ['transcribe.transcript', 'key']
      }
    });
  }

  // 미디어 타입 필터
  if (filters.type) {
    filter.push({
      term: { type: filters.type }
    });
  }

  // 날짜 범위 필터
  if (filters.dateRange) {
    filter.push({
      range: {
        timestamp: {
          gte: filters.dateRange.start,
          lte: filters.dateRange.end
        }
      }
    });
  }

  // 파일 크기 필터
  if (filters.sizeRange) {
    filter.push({
      range: {
        fileSize: {
          gte: filters.sizeRange.min,
          lte: filters.sizeRange.max
        }
      }
    });
  }

  const searchParams = {
    index: 'media2cloud-*',
    body: {
      query: {
        bool: {
          must: must,
          filter: filter
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

### 5.3 집계 검색 (Aggregations)
```javascript
// 패싯 검색을 위한 집계
const getFacets = async () => {
  const searchParams = {
    index: 'media2cloud-*',
    body: {
      size: 0,
      aggs: {
        types: {
          terms: {
            field: 'type',
            size: 10
          }
        },
        date_histogram: {
          date_histogram: {
            field: 'timestamp',
            calendar_interval: 'month'
          }
        },
        file_size_ranges: {
          range: {
            field: 'fileSize',
            ranges: [
              { to: 1048576 },           // < 1MB
              { from: 1048576, to: 10485760 }, // 1MB - 10MB
              { from: 10485760, to: 104857600 }, // 10MB - 100MB
              { from: 104857600 }        // > 100MB
            ]
          }
        },
        top_labels: {
          nested: {
            path: 'rekognition.labels'
          },
          aggs: {
            labels: {
              terms: {
                field: 'rekognition.labels.name.keyword',
                size: 20
              }
            }
          }
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

### 5.4 벡터 유사도 검색
```javascript
// 얼굴 임베딩 기반 유사도 검색
const searchSimilarFaces = async (queryVector, threshold = 0.8) => {
  const searchParams = {
    index: 'media2cloud-faces',
    body: {
      query: {
        script_score: {
          query: { match_all: {} },
          script: {
            source: "cosineSimilarity(params.query_vector, 'embedding') + 1.0",
            params: {
              query_vector: queryVector
            }
          },
          min_score: threshold
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

## 6. 고급 검색 기능

### 6.1 시간 기반 검색
```javascript
// 특정 시간대의 콘텐츠 검색
const searchByTimeRange = async (startTime, endTime, mediaType) => {
  const searchParams = {
    index: 'media2cloud-analysis',
    body: {
      query: {
        bool: {
          must: [
            {
              nested: {
                path: 'transcribe.segments',
                query: {
                  bool: {
                    must: [
                      {
                        range: {
                          'transcribe.segments.startTime': {
                            gte: startTime,
                            lte: endTime
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          ],
          filter: [
            { term: { type: mediaType } }
          ]
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

### 6.2 지리적 검색 (GPS 메타데이터 기반)
```javascript
// 위치 기반 검색
const searchByLocation = async (lat, lon, distance) => {
  const searchParams = {
    index: 'media2cloud-*',
    body: {
      query: {
        geo_distance: {
          distance: distance,
          location: {
            lat: lat,
            lon: lon
          }
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

### 6.3 감정 기반 검색
```javascript
// 감정 분석 결과 기반 검색
const searchBySentiment = async (sentiment, confidence = 0.7) => {
  const searchParams = {
    index: 'media2cloud-analysis',
    body: {
      query: {
        bool: {
          must: [
            {
              term: {
                'comprehend.sentiment.sentiment': sentiment
              }
            },
            {
              range: {
                [`comprehend.sentiment.${sentiment.toLowerCase()}`]: {
                  gte: confidence
                }
              }
            }
          ]
        }
      }
    }
  };

  return await client.search(searchParams);
};
```

## 7. 성능 최적화

### 7.1 인덱스 설정 최적화
```json
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 1,
    "refresh_interval": "30s",
    "index.mapping.total_fields.limit": 2000,
    "index.max_result_window": 50000
  }
}
```

### 7.2 쿼리 최적화
```javascript
// 효율적인 쿼리 구조
const optimizedSearch = async (query) => {
  const searchParams = {
    index: 'media2cloud-*',
    body: {
      query: {
        bool: {
          must: [
            // 가장 선택적인 조건을 먼저
            { term: { type: 'video' } }
          ],
          should: [
            // 부스팅을 통한 관련성 조정
            { 
              match: { 
                'transcribe.transcript': {
                  query: query,
                  boost: 2.0
                }
              }
            },
            {
              match: {
                'rekognition.labels.name': {
                  query: query,
                  boost: 1.0
                }
              }
            }
          ],
          minimum_should_match: 1
        }
      },
      // 필요한 필드만 반환
      _source: [
        'uuid', 'key', 'timestamp', 'type',
        'transcribe.transcript', 'rekognition.labels'
      ]
    }
  };

  return await client.search(searchParams);
};
```

### 7.3 캐싱 전략
```javascript
// 자주 사용되는 쿼리 캐싱
const cachedSearch = async (query, cacheKey) => {
  // Redis 캐시 확인
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // OpenSearch 검색 실행
  const result = await client.search(query);
  
  // 결과 캐싱 (5분)
  await redis.setex(cacheKey, 300, JSON.stringify(result));
  
  return result;
};
```

## 8. 모니터링 및 관리

### 8.1 클러스터 상태 모니터링
```javascript
// 클러스터 헬스 체크
const checkClusterHealth = async () => {
  const health = await client.cluster.health();
  
  const metrics = {
    status: health.body.status,
    numberOfNodes: health.body.number_of_nodes,
    numberOfDataNodes: health.body.number_of_data_nodes,
    activePrimaryShards: health.body.active_primary_shards,
    activeShards: health.body.active_shards,
    relocatingShards: health.body.relocating_shards,
    initializingShards: health.body.initializing_shards,
    unassignedShards: health.body.unassigned_shards
  };

  return metrics;
};
```

### 8.2 인덱스 관리
```javascript
// 인덱스 롤오버 (크기 기반)
const rolloverIndex = async (alias, maxSize = '5gb') => {
  const rolloverParams = {
    alias: alias,
    body: {
      conditions: {
        max_size: maxSize,
        max_age: '30d'
      }
    }
  };

  return await client.indices.rollover(rolloverParams);
};

// 오래된 인덱스 삭제
const deleteOldIndices = async (pattern, days = 90) => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const indices = await client.cat.indices({
    index: pattern,
    format: 'json'
  });

  for (const index of indices.body) {
    const indexDate = new Date(index.creation_date_string);
    if (indexDate < cutoffDate) {
      await client.indices.delete({ index: index.index });
    }
  }
};
```

## 9. 보안 설정

### 9.1 액세스 제어
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::account:role/Media2CloudRole"
      },
      "Action": [
        "es:ESHttpGet",
        "es:ESHttpPost",
        "es:ESHttpPut"
      ],
      "Resource": "arn:aws:es:region:account:domain/media2cloud/*"
    }
  ]
}
```

### 9.2 암호화 설정
```yaml
# 전송 중 암호화
DomainEndpointOptions:
  EnforceHTTPS: true
  TLSSecurityPolicy: "Policy-Min-TLS-1-2-2019-07"

# 저장 시 암호화
EncryptionAtRestOptions:
  Enabled: true

# 노드 간 암호화
NodeToNodeEncryptionOptions:
  Enabled: true
```

