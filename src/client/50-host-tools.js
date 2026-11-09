    // ── 宿主工具页 ────────────────────────────────────────────────────────────────
    //
    // 独立侧车 host-tools.json，与兼容页的「模型工具表」（本插件自己 24 条）分开：
    // 这里管的是宿主注册、可被 tools.restrict 摘除的工具；那边管的是插件自己发给模型的工具。
    // 保留名单（pwsh / edit / read / write / glob / grep）在服务端写盘前就拒掉，界面同时
    // 把开关置灰，两侧一致 —— 关掉这些会让 agent 失去基本工作能力。
    function HostToolsPage(props) {
      var t = props && props.t ? props.t : function (k) { return k }
      var scopeState = useScopeLayer()
      var ss = react.useState({ loading: true, error: null, data: null }), snapshot = ss[0], setSnapshot = ss[1]
      var bs = react.useState(false), busy = bs[0], setBusy = bs[1]
      var qs = react.useState(''), query = qs[0], setQuery = qs[1]
      var rs = react.useState(null), result = rs[0], setResult = rs[1]

      /** 面板当前编辑的层：与 scope-get 同一份状态，切层后写操作落在新的那层。 */
      function currentScope() {
        var mode = scopeState.mode || 'global'
        if (mode === 'global' || !scopeState.sessionId) return { kind: 'global', key: '' }
        return { kind: mode, key: scopeState.sessionId }
      }

      function load() {
        setSnapshot(function (prev) { return { loading: true, error: null, data: prev.data } })
        apiCall('host-tools', { scope: currentScope() }).then(function (r) {
          if (r && r.ok) setSnapshot({ loading: false, error: null, data: r.data || {} })
          else setSnapshot({ loading: false, error: (r && (r.code || r.error)) || 'loadFailed', data: null })
        }).catch(function (e) {
          setSnapshot({ loading: false, error: String(e && e.message || e), data: null })
        })
      }
      // 切层必须重新拉一次：不订阅时页面停在切层前那份快照。
      react.useEffect(function () { load() }, [scopeState.mode, scopeState.sessionId])

      /** 逐条改：走 op 的 toggle 分支，不整份替换，避免与面板另一处写者互相覆盖。 */
      function toggle(name, hidden) {
        if (busy) return
        setBusy(true); setResult(null)
        apiCall('host-tools', { scope: currentScope(), toggle: [{ name: name, hidden: !hidden }] }).then(function (r) {
          setBusy(false)
          if (r && r.ok) { load() }
          else setResult({ kind: 'err', text: (r && (r.code || r.error)) || 'saveFailed' })
        }).catch(function (e) {
          setBusy(false)
          setResult({ kind: 'err', text: String(e && e.message || e) })
        })
      }

      var data = snapshot.data || {}
      var hidden = {}
      for (var i = 0; i < (data.hidden || []).length; i += 1) hidden[data.hidden[i]] = true
      var tools = data.tools || []
      var q = String(query || '').trim().toLowerCase()
      var shown = q ? tools.filter(function (row) { return row.name.toLowerCase().indexOf(q) >= 0 }) : tools
      var offCount = (data.hidden || []).length

      return h('div', { className: 'dsm-panel' },
        h(PageHead, {
          key: 'head',
          title: t('tools.title'),
          desc: t('tools.desc'),
          stats: [[String(offCount) + '/' + String(tools.length), t('tools.stat.hidden')]],
          actions: [h('button', {
            key: 'refresh', type: 'button', className: 'dsm-btn dsm-btn-quiet', disabled: busy,
            onClick: load,
          }, t('tools.refresh'))],
        }),
        result ? h('div', { key: 'result', className: 'dsm-feedback ' + (result.kind === 'err' ? 'dsm-error' : 'dsm-ok'), role: 'status' }, result.text) : null,
        snapshot.loading && !snapshot.data
          ? h('div', { key: 'loading', className: 'dsm-empty' }, t('tools.loading'))
          : snapshot.error
            ? h('div', { key: 'err', className: 'dsm-feedback dsm-error' }, t('tools.loadFailed'))
            : null,
        snapshot.data ? h('div', { key: 'toolbar', className: 'dsm-toolbar' },
          h('input', {
            className: 'dsm-control dsm-search', value: query, 'aria-label': t('tools.search'),
            placeholder: t('tools.search'), onChange: function (e) { setQuery(e.target.value) },
          })
        ) : null,
        snapshot.data ? h('div', { key: 'list', className: 'dsm-list' },
          shown.length === 0
            ? h('div', { className: 'dsm-empty' }, t('tools.empty'))
            : shown.map(function (row) {
              var isOff = hidden[row.name] === true
              return h('div', { key: row.name, className: 'dsm-listrow' },
                h('div', { className: 'dsm-listrow-main' },
                  h('div', { className: 'dsm-listrow-name-row' },
                    h('span', { className: 'dsm-listrow-name' }, row.name),
                    row.protectedTool ? h('span', { className: 'dsm-tag', title: t('tools.protectedTip') }, t('tools.protected')) : null
                  )
                ),
                h('div', { className: 'dsm-listrow-side' },
                  h(Switch, {
                    on: !isOff,
                    disabled: busy || row.protectedTool,
                    label: row.name,
                    title: row.protectedTool ? t('tools.protectedTip') : (isOff ? t('tools.enable') : t('tools.disable')),
                    onClick: function () { toggle(row.name, isOff) },
                  })
                )
              )
            })
        ) : null
      )
    }
