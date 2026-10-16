// ═══════════════════════════════════════════════════════════════════
// sync_provider_supabase.js — [Phase 6, ADR-005/006/007] Supabase Provider Adapter
// ═══════════════════════════════════════════════════════════════════
// ⚠️ مرجعي غير مُختبَر مقابل مشروع Supabase حقيقي. لم يُدرَج في index.html عمدًا —
// لا يُحمَّل ولا يُنفَّذ في أي بناء إنتاجي حاليًا. لا يوجد مشروع Supabase فعلي، ولا
// بيانات اعتماد، ولا اختبار حقيقي بجهازين مستقلين تم إجراؤه على هذا الملف. راجع
// التقرير النهائي (Section "Production Gate") لسبب بقاء هذا الملف مرجعيًا فقط.
//
// الغرض: تنفيذ SyncProviderInterface (المُعرَّف نهائيًا في sync.js) عبر Supabase —
// بدون أي اعتماد مباشر لـ sync.js/SyncManager على Supabase SDK نفسه (عزل كامل،
// راجع ADR-005 §Provider). أي كود آخر في التطبيق لا يعرف بوجود هذا الملف إطلاقًا.
//
// الاستخدام المتوقَّع (مستقبلًا، بعد توفر مشروع Supabase حقيقي ومصادقة مُختبَرة):
//   const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
//   const provider = createSupabaseSyncProvider(client);
//   await provider.connect({}); // بعد أن يكون المستخدم قد سجّل دخوله فعليًا عبر client.auth
//   SyncManager.init(provider);
//   SyncManager.enabled = true; // فقط بعد اجتياز كل الـ Gates — راجع التقرير النهائي
//
// لا تضع أي مفتاح/سر داخل هذا الملف أو أي ملف مصدر آخر — SUPABASE_URL/ANON_KEY
// (المفتاح العام فقط، ليس service_role) تُمرَّر من تهيئة خارجية وقت التشغيل.

function createSupabaseSyncProvider(supabaseClient){
  if(!supabaseClient) throw new Error('createSupabaseSyncProvider: يتطلب عميل Supabase مُهيَّأ مسبقًا');

  return {
    name:'supabase',

    // ── connect(config) → {ok, error?} ──
    // لا يقوم هذا بتسجيل الدخول (auth منفصل تمامًا — راجع ADR-006 §Device Identity).
    // فقط يتحقق من وجود جلسة مصادقة فعلية قبل السماح بأي عملية مزامنة.
    async connect(config){
      try{
        const { data:{ session }, error } = await supabaseClient.auth.getSession();
        if(error) return { ok:false, error: error.message };
        if(!session) return { ok:false, error:'no-authenticated-session' };
        return { ok:true };
      }catch(e){ return { ok:false, error:e.message }; }
    },

    // ── uploadBatch(operations) → {ok, results:[{operationId, ok, serverRevision?, error?}]} ──
    // operations: [{operationId, operationType, entityType, entityId, deviceId, timestamp, payload}]
    //
    // [Phase 3 §C3+C4] Two genuinely different concerns, handled by two genuinely
    // different mechanisms — do not conflate them:
    //  1) CURRENT-STATE identity — (owner_id, entity_type, entity_id) — the upsert's
    //     onConflict target. One row per entity, always overwritten in place.
    //  2) OPERATION identity / idempotency — (owner_id, operation_id) — tracked
    //     server-side in the sync_operations ledger (production_sync_schema.sql),
    //     NOT by this upsert's own ON CONFLICT clause at all. The ledger is what the
    //     sync_records_assign_revision() trigger consults to decide, atomically,
    //     whether a given operation_id is genuinely new or an already-accepted retry.
    async uploadBatch(operations){
      try{
        const rows=operations.map(op=>({
          entity_type:op.entityType, entity_id:String(op.entityId),
          operation_id:op.operationId, device_id:op.deviceId||null,
          client_timestamp:op.timestamp||null,
          payload: op.operationType==='delete' ? null : op.payload,
          deleted: op.operationType==='delete',
          // owner_id عمدًا غير مُرسَل من العميل هنا — يُشتَق من default auth.uid() في
          // السيرفر (راجع ADR-007 §RLS)، وليس من أي حقل عميل موثوق فيه.
        }));
        // onConflict يستهدف هوية current-state الفعلية (نفس أعمدة
        // sync_records_owner_entity_uidx بالضبط) — وليس operation_id، الذي لا علاقة له
        // بتحديد "هل هذا نفس السجل" بل بتحديد "هل هذه نفس العملية" (سؤال مختلف تمامًا،
        // يُحسَم داخل الـ trigger عبر دفتر sync_operations، وليس هنا).
        const { error:upsertErr } = await supabaseClient
          .from('sync_records')
          .upsert(rows, { onConflict:'owner_id,entity_type,entity_id', ignoreDuplicates:false });
        if(upsertErr) return { ok:false, error:upsertErr.message, code: _classifySupabaseError(upsertErr) };

        // النتيجة الفعلية لكل عملية (قُبلت أم لا، وبأي server_revision) تُقرَأ من دفتر
        // العمليات الدائم (sync_operations) — وليس من عمود sync_records.operation_id،
        // الذي قد يكون تجاوزته عملية لاحقة على نفس الكيان (سيناريو S8: إعادة محاولة
        // متأخرة لعملية سبق قبولها، بعد أن حدَّثها عملية أخرى بالفعل — الصف الحالي
        // سيُظهر تلك العملية الأحدث، لا هذه، فالاعتماد عليه هنا كان سيُبلِّغ خطأً بأن
        // إعادة المحاولة "فشلت" رغم أنها نجحت فعلًا في الأصل).
        const opIds=operations.map(op=>op.operationId);
        const { data:ledgerRows, error:ledgerErr } = await supabaseClient
          .from('sync_operations').select('operation_id, server_revision')
          .in('operation_id', opIds);
        if(ledgerErr) return { ok:false, error:ledgerErr.message, code: _classifySupabaseError(ledgerErr) };

        const revByOpId={}; (ledgerRows||[]).forEach(r=>{ revByOpId[r.operation_id]=r.server_revision; });
        return {
          ok:true,
          results: operations.map(op=>({
            operationId:op.operationId, ok: revByOpId[op.operationId]!=null,
            serverRevision: revByOpId[op.operationId],
          })),
        };
      }catch(e){ throw _toProviderError(e); }
    },

    // ── downloadChanges(cursor, pageSize) → {ok, changes, nextCursor, hasMore} أو
    //    {ok:false, code:'CURSOR_TOO_OLD'} ──
    // يقرأ من sync_log (مؤشرات فقط) ثم يُجمِّع (join) مع sync_records للحصول على
    // الحالة الحالية الفعلية لكل كيان — يطابق تمامًا سلوك createLocalMockSyncProvider
    // في sync.js حتى يبقى محرّك syncNow() الحالي غير مُعدَّل. راجع ADR-007 §Schema.
    async downloadChanges(cursor, pageSize){
      try{
        const since=cursor||0; const size=pageSize||200;

        // فحص الاحتفاظ: لو أقدم إدخال log لا يزال محفوظًا أحدث من cursor العميل (وcursor
        // ليس 0)، فالتاريخ المطلوب لم يعد متاحًا — راجع ADR-005 §Cursor Too Old.
        if(since>0){
          const { data:floorRow } = await supabaseClient
            .from('sync_log').select('server_revision').order('server_revision', {ascending:true}).limit(1).maybeSingle();
          if(floorRow && since < floorRow.server_revision) return { ok:false, code:'CURSOR_TOO_OLD' };
        }

        const { data:logPage, error:logErr } = await supabaseClient
          .from('sync_log').select('server_revision, entity_type, entity_id')
          .gt('server_revision', since).order('server_revision', {ascending:true}).limit(size+1);
        if(logErr) return { ok:false, error:logErr.message, code:_classifySupabaseError(logErr) };

        const hasMore = (logPage||[]).length > size;
        const page = (logPage||[]).slice(0, size);
        if(!page.length) return { ok:true, changes:[], nextCursor:since, hasMore:false };

        // [Phase 4 §H1] Composite-identity lookup via RPC — filters on (entity_type, entity_id)
        // pairs using PostgreSQL's element-wise unnest() zip. SECURITY INVOKER; owner_id
        // scoped by RLS on sync_records; no owner param accepted from the client.
        const { data:records, error:recErr } = await supabaseClient
          .rpc('sync_records_by_entity_pairs', {
            p_entity_types: page.map(l=>l.entity_type),
            p_entity_ids:   page.map(l=>String(l.entity_id)),
          });
        if(recErr) return { ok:false, error:recErr.message, code:_classifySupabaseError(recErr) };

        const byKey={}; (records||[]).forEach(r=>{ byKey[r.entity_type+'|'+r.entity_id]=r; });
        const changes=page.map(l=>{
          const rec=byKey[l.entity_type+'|'+l.entity_id];
          if(!rec) return null;
          return {
            entityType:rec.entity_type, entityId:rec.entity_id, operationId:rec.operation_id,
            deviceId:rec.device_id, clientTimestamp:rec.client_timestamp,
            serverRevision:rec.server_revision, payload:rec.payload, deleted:!!rec.deleted,
            logRevision:l.server_revision,
          };
        }).filter(Boolean);

        const nextCursor=page[page.length-1].server_revision;
        return { ok:true, changes, nextCursor, hasMore };
      }catch(e){ throw _toProviderError(e); }
    },

    // ── downloadSnapshot(snapshotRevision, afterRevision, pageSize) ──
    // يُستدعى عند CURSOR_TOO_OLD أو لجهاز جديد (cursor=0 && !bootstrapDone) — يقرأ sync_records مباشرةً (لا sync_log).
    // RLS تضمن owner scope على auth.uid() — لا owner_id يُرسَل من العميل.
    async downloadSnapshot(snapshotRevision, afterRevision, pageSize){
      try{
        const size=pageSize||200;
        const since=afterRevision||0;

        // في أول استدعاء (snapshotRevision==null): احسب MAX(server_revision) أولًا
        // قبل أي قراءة — يضمن أن كل write يحدث بعد هذه اللحظة له revision > snapshotRevision
        // فيُحصَد لاحقًا عبر downloadChanges(snapshotRevision).
        let maxRev=snapshotRevision;
        if(maxRev==null){
          const { data:maxRow, error:maxErr }=await supabaseClient
            .from('sync_records')
            .select('server_revision')
            .order('server_revision',{ascending:false})
            .limit(1)
            .maybeSingle();
          if(maxErr) return { ok:false, error:maxErr.message, code:_classifySupabaseError(maxErr) };
          maxRev=maxRow ? maxRow.server_revision : 0;
        }

        // جلب sync_records بـ keyset pagination — بلا JOIN مع sync_log
        const { data, error }=await supabaseClient
          .from('sync_records')
          .select('entity_type, entity_id, operation_id, device_id, client_timestamp, server_revision, payload, deleted')
          .gt('server_revision', since)
          .lte('server_revision', maxRev)
          .order('server_revision',{ascending:true})
          .limit(size+1);
        if(error) return { ok:false, error:error.message, code:_classifySupabaseError(error) };

        const hasMore=(data||[]).length>size;
        const page=(data||[]).slice(0,size);
        const records=page.map(r=>({
          entityType:r.entity_type, entityId:r.entity_id,
          operationId:r.operation_id||null, deviceId:r.device_id||null,
          clientTimestamp:r.client_timestamp||null,
          serverRevision:r.server_revision,
          payload:r.payload||null, deleted:!!r.deleted,
        }));
        return { ok:true, records, snapshotRevision:maxRev, hasMore };
      }catch(e){ throw _toProviderError(e); }
    },

    async disconnect(){
      try{ await supabaseClient.auth.signOut(); return { ok:true }; }
      catch(e){ return { ok:false, error:e.message }; }
    },
  };
}

// ── يصنّف أخطاء Supabase الشائعة إلى الأكواد التي يفهمها _syncClassifyError في sync.js ──
function _classifySupabaseError(error){
  if(!error) return undefined;
  const msg=(error.message||'').toLowerCase();
  // Auth failures — checked first; may accompany any HTTP/DB status.
  if(error.code==='PGRST301' || msg.includes('jwt') || msg.includes('expired')) return 'AUTH_EXPIRED';
  // [N1] Permanent Postgres SQLSTATE classes (PostgREST exposes these as string codes):
  //   23xxx — integrity constraint violations: NOT NULL (23502), FK (23503), UNIQUE (23505),
  //            CHECK (23514), exclusion (23P01), and all other class-23 variants.
  //   42xxx — SQL/schema permanent errors: invalid ON CONFLICT target (42P10), undefined
  //            column (42703), undefined table (42P01), and other class-42 variants.
  // None of these can succeed on retry — returning PERMANENT causes _syncClassifyError in
  // sync.js to map to 'permanent', which scheduleRetry treats as non-retryable (no backoff loop).
  const pg=typeof error.code==='string' ? error.code : '';
  if(pg.startsWith('23') || pg.startsWith('42')) return 'PERMANENT';
  // Preserved legacy message-based fallback: catches constraint/validation errors that arrive
  // without a structured SQLSTATE code (e.g. from middleware or non-Postgres error sources).
  if(msg.includes('constraint') || msg.includes('invalid input')) return 'VALIDATION_ERROR';
  return undefined; // غير مصنَّف → sync.js يُعامله كخطأ شبكة قابل لإعادة المحاولة (الأكثر أمانًا)
}
function _toProviderError(e){
  const err=new Error(e.message||'supabase-provider-error');
  err.code=_classifySupabaseError(e);
  return err;
}
