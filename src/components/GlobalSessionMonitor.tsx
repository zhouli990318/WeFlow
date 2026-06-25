import { useEffect, useRef, useCallback } from 'react'
import { useChatStore } from '../stores/chatStore'
import type { ChatSession, Message } from '../types/models'
import { useNavigate } from 'react-router-dom'

const SESSION_REFRESH_DEBOUNCE_MS = 300

export function GlobalSessionMonitor() {
    const navigate = useNavigate()
    const {
        sessions,
        setSessions,
        currentSessionId,
        appendMessages,
        messages
    } = useChatStore()

    const sessionsRef = useRef(sessions)
    // 保持 ref 同步
    useEffect(() => {
        sessionsRef.current = sessions
    }, [sessions])

    // 去重辅助函数：获取消息 key
    const getMessageKey = useCallback((msg: Message) => {
        if (msg.messageKey) return msg.messageKey
        return `fallback:${msg._db_path || ''}:${msg.serverId || 0}:${msg.createTime}:${msg.sortSeq || 0}:${msg.localId || 0}:${msg.senderUsername || ''}:${msg.localType || 0}`
    }, [])

    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 处理数据库变更
    useEffect(() => {
        const handleDbChange = (_event: any, data: { type: string; json: string }) => {
            try {
                const payload = JSON.parse(data.json)
                const tableName = payload.table

                // 只关注 Session 表，防抖合并多次变更
                if (tableName === 'Session' || tableName === 'session') {
                    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
                    refreshTimerRef.current = setTimeout(() => refreshSessions(), SESSION_REFRESH_DEBOUNCE_MS)
                }
            } catch (e) {
                console.error('解析数据库变更失败:', e)
            }
        }

        if (window.electronAPI.chat.onWcdbChange) {
            const removeListener = window.electronAPI.chat.onWcdbChange(handleDbChange)
            return () => {
                removeListener()
                if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
            }
        }
        return () => {
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
        }
    }, [])

    const refreshSessions = async () => {
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions && Array.isArray(result.sessions)) {
                const newSessions = result.sessions as ChatSession[]
                const oldSessions = sessionsRef.current

                // 1. 检测变更并通知
                checkForNewMessages(oldSessions, newSessions)

                // 2. 仅在会话列表有实质变化时更新 store
                const hasChanged = !oldSessions ||
                    oldSessions.length !== newSessions.length ||
                    (newSessions.length > 0 && oldSessions.length > 0 &&
                        (newSessions[0].lastTimestamp !== oldSessions[0].lastTimestamp ||
                         newSessions[0].username !== oldSessions[0].username))
                if (hasChanged) {
                    setSessions(newSessions)
                }

                // 3. 如果在活跃会话中，增量刷新消息
                const currentId = useChatStore.getState().currentSessionId
                if (currentId) {
                    const currentSessionNew = newSessions.find(s => s.username === currentId)
                    const currentSessionOld = oldSessions?.find(s => s.username === currentId)

                    if (currentSessionNew && (!currentSessionOld || currentSessionNew.lastTimestamp > currentSessionOld.lastTimestamp)) {
                        void handleActiveSessionRefresh(currentId)
                    }
                }
            }
        } catch (e) {
            console.error('全局会话刷新失败:', e)
        }
    }

    const cleanWxid = (id: string) => {
        if (!id) return '';
        const trimmed = id.trim();
        const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/);
        return suffixMatch ? suffixMatch[1] : trimmed;
    }

    const checkForNewMessages = async (oldSessions: ChatSession[], newSessions: ChatSession[]) => {
        if (!oldSessions || oldSessions.length === 0) return

        const oldMap = new Map(oldSessions.map(s => [s.username, s]))
        const currentId = useChatStore.getState().currentSessionId

        // 第一遍：筛选出需要发送通知的会话
        const toNotify: ChatSession[] = []
        for (const newSession of newSessions) {
            const oldSession = oldMap.get(newSession.username)
            if (newSession.username === currentId) continue
            if (oldSession && newSession.lastTimestamp <= oldSession.lastTimestamp) continue
            if (newSession.isMuted || newSession.isFolded) continue
            if (newSession.username.toLowerCase().includes('placeholder_foldgroup')) continue

            // 群聊过滤自己发送的消息
            if (newSession.username.includes('@chatroom')) {
                if (newSession.lastMsgSender && newSession.selfWxid) {
                    if (cleanWxid(newSession.lastMsgSender) === cleanWxid(newSession.selfWxid)) continue
                }
                if (newSession.unreadCount <= (oldSession?.unreadCount ?? 0)) continue
            } else {
                if (newSession.unreadCount <= (oldSession?.unreadCount ?? 0)) continue
            }
            toNotify.push(newSession)
        }

        if (toNotify.length === 0) return

        // 第二遍：批量获取需要 enrichment 的联系人信息
        const needsEnrichment = toNotify.filter(s => !s.displayName || !s.avatarUrl || s.displayName === s.username)
        const enrichmentMap = new Map<string, { displayName?: string; avatarUrl?: string }>()
        if (needsEnrichment.length > 0) {
            const usernames = needsEnrichment.map(s => s.username).filter(Boolean)
            try {
                const enrichResult = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
                if (enrichResult.success && enrichResult.contacts) {
                    for (const [username, info] of Object.entries(enrichResult.contacts)) {
                        enrichmentMap.set(username, info as any)
                    }
                }
            } catch { /* 忽略批量获取失败 */ }
        }

        // 第三遍：发送通知
        for (const session of toNotify) {
            let title = session.displayName || session.username
            let avatarUrl = session.avatarUrl
            let content = session.summary || '[新消息]'

            if (session.username.includes('@chatroom') && session.lastSenderDisplayName) {
                content = `${session.lastSenderDisplayName}: ${content}`
            }

            // 使用预取的 enrichment 数据
            const enriched = enrichmentMap.get(session.username)
            if (enriched) {
                if (enriched.displayName) title = enriched.displayName
                if (enriched.avatarUrl) avatarUrl = enriched.avatarUrl
            }

            const isGroupChat = session.username.includes('@chatroom')
            if (title.startsWith('wxid_') && title === session.username && !isGroupChat) continue

            window.electronAPI.notification?.show({
                title,
                content,
                avatarUrl,
                sessionId: session.username
            })
        }
    }

    const handleActiveSessionRefresh = async (sessionId: string) => {
        // 从 ChatPage 复制/调整的逻辑，以保持集中
        const state = useChatStore.getState()
        const msgs = state.messages || []
        const lastMsg = msgs[msgs.length - 1]
        const minTime = lastMsg?.createTime || 0

        try {
            const result = await (window.electronAPI.chat as any).getNewMessages(sessionId, minTime)
            if (result.success && result.messages && result.messages.length > 0) {
                const latestMessages = useChatStore.getState().messages || []
                const existingKeys = new Set(latestMessages.map(getMessageKey))
                const newMessages = result.messages.filter((msg: Message) => !existingKeys.has(getMessageKey(msg)))
                if (newMessages.length > 0) {
                    appendMessages(newMessages, false)
                }
            }
        } catch (e) {
            console.warn('后台活跃会话刷新失败:', e)
        }
    }

    // 此组件不再渲染 UI
    return null
}
