const express = require('express');
const { createProxyMiddleware, responseInterceptor, fixRequestBody } = require('http-proxy-middleware');

const app = express();

// --- Configuration ---
// Replace with your actual Emby server URL and Port, or pass via environment variable
const EMBY_URL = process.env.EMBY_URL || 'http://YOUR_EMBY_IP:8096'; 

// Generate a unique UUID for your proxy instance, or pass via environment variable
const PROXY_SERVER_ID = process.env.PROXY_SERVER_ID || "YOUR_UNIQUE_UUID_HERE";  

const tokenToUserId = {};

// --- Express Body Parser ---
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Debug Logger ---
app.use((req, res, next) => {
    console.log(`[DEBUG] Incoming Request: ${req.method} ${req.url}`);
    next();
});

// --- 1. Bijective UUID Generator ---
const toUUID = (id) => {
    if (!id) return "00000000-0000-0000-0000-000000000000";
    const s = String(id).replace(/-/g, '').toLowerCase();
    
    if (s.length === 32) {
        return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
    }

    const padded = s.padStart(32, '0'); // Pad with zeros
    const prefixed = 'ffffffff' + padded.slice(8);
    return `${prefixed.slice(0,8)}-${prefixed.slice(8,12)}-${prefixed.slice(12,16)}-${prefixed.slice(16,20)}-${prefixed.slice(20)}`;
};

// --- 2. The Jellyfin Bubble Wrappers ---
const patchUser = (user) => {
    if (!user) return user;
    
    const imgTags = user.ImageTags || {};
    const effectiveTag = user.PrimaryImageTag || user.ImageTag || imgTags.Primary;

    if (effectiveTag) {
        imgTags.Primary = effectiveTag;
        user.PrimaryImageTag = effectiveTag;
        user.HasPrimaryImage = true;
    } else {
        user.HasPrimaryImage = false;
    }

    return {
        ...user,
        Id: toUUID(user.Id),
        ServerId: PROXY_SERVER_ID,
        ImageTags: imgTags,
        HasConfiguredEasyPassword: user.HasConfiguredEasyPassword || false,
        HasConfiguredPassword: user.HasConfiguredPassword || false,
        Configuration: {
            PlayDefaultAudioTrack: true,
            SubtitleLanguagePreference: "eng",
            DisplayMissingEpisodes: false,
            GroupedFolders: [],
            OrderedViews: [],
            LatestItemsExcludes: [],
            MyMediaExcludes: [],
            HidePlayedInLatest: true,
            SubtitleMode: "Default",
            DisplayCollectionsView: false,
            EnableLocalPassword: false,
            RememberAudioSelections: true,
            RememberSubtitleSelections: true,
            EnableNextEpisodeAutoPlay: true,
            ...(user.Configuration || {})
        },
        Policy: {
            IsAdministrator: user.Policy?.IsAdministrator || false,
            IsHidden: false,
            IsDisabled: false,
            BlockedTags: [],
            EnableUserPreferenceAccess: true,
            AccessSchedules: [],
            BlockUnratedItems: [],
            EnableRemoteControlOfOtherUsers: false,
            EnableSharedDeviceControl: true,
            EnableRemoteAccess: true,
            EnableLiveTvManagement: false,
            EnableLiveTvAccess: false,
            EnableMediaPlayback: true,
            EnableAudioPlaybackTranscoding: true,
            EnableVideoPlaybackTranscoding: true,
            EnablePlaybackRemuxing: true,
            ForceRemoteSourceTranscoding: false,
            EnableContentDeletion: false,
            EnableContentDeletionFromFolders: [],
            EnableContentDownloading: false,
            EnableSyncTranscoding: false,
            EnableMediaConversion: false,
            EnabledDevices: [],
            EnableAllDevices: true,
            EnabledChannels: [],
            EnableAllChannels: true,
            EnabledFolders: [],
            EnableAllFolders: true,
            InvalidLoginAttemptCount: 0,
            LoginAttemptsBeforeLockout: 15,
            MaxActiveSessions: 0,
            EnablePublicSharing: false,
            BlockedMediaFolders: [],
            BlockedChannels: [],
            RemoteClientBitrateLimit: 0,
            AuthenticationProviderId: "Emby.Server.Implementations.Library.DefaultAuthenticationProvider",
            PasswordResetProviderId: "Emby.Server.Implementations.Library.DefaultPasswordResetProvider",
            SyncPlayAccess: "CreateAndJoinGroups",
            ...(user.Policy || {})
        }
    };
};

const patchSessionInfo = (sessionInfo) => {
    if (!sessionInfo) return sessionInfo;
    return {
        ...sessionInfo,
        Id: toUUID(sessionInfo.Id),
        UserId: toUUID(sessionInfo.UserId),
        LastPlaybackCheckIn: sessionInfo.LastPlaybackCheckIn || "0001-01-01T00:00:00.0000000Z",
        IsActive: sessionInfo.IsActive !== undefined ? sessionInfo.IsActive : true,
        SupportsMediaControl: sessionInfo.SupportsMediaControl !== undefined ? sessionInfo.SupportsMediaControl : true,
        HasCustomDeviceName: sessionInfo.HasCustomDeviceName || false,
        ServerId: PROXY_SERVER_ID,
        PlayState: {
            PlaybackOrder: "Default",
            RepeatMode: "RepeatNone",
            ...(sessionInfo.PlayState || {})
        }
    };
};

// --- 3. The Global Deep-Patcher ---
const deepPatch = (obj, parentId = "") => {
    if (!obj) return;

    if (Array.isArray(obj)) {
        obj.forEach(item => deepPatch(item, parentId));
        return;
    }

    if (typeof obj === 'object' && obj !== null) {
        
        if (obj.Items && Array.isArray(obj.Items)) {
            obj.StartIndex = parseInt(obj.StartIndex) || 0;
            obj.TotalRecordCount = obj.TotalRecordCount !== undefined ? parseInt(obj.TotalRecordCount) : obj.Items.length;
        }

        const currentId = obj.Id ? String(obj.Id) : parentId;

        if (obj.Id || obj.ItemId) {
            obj.ServerId = PROXY_SERVER_ID;
            if (!obj.ImageTags) obj.ImageTags = {};
            if (!obj.BackdropImageTags) obj.BackdropImageTags = [];
            if (!obj.ProviderIds) obj.ProviderIds = {};
            if (!obj.ImageBlurHashes) obj.ImageBlurHashes = {}; 
            if (!obj.LocationType) obj.LocationType = "FileSystem";
            if (!obj.SourceType) obj.SourceType = "Local";
            if (!obj.PlayAccess) obj.PlayAccess = "Full";
            
            if (obj.PrimaryImageTag && !obj.ImageTags.Primary) {
                obj.ImageTags.Primary = obj.PrimaryImageTag;
                obj.HasPrimaryImage = true;
            }

            if (obj.Type) {
                const folderTypes = ["Folder", "CollectionFolder", "UserView", "BoxSet", "Series", "Season", "MusicAlbum", "MusicArtist", "Playlist", "Genre", "Studio", "Person"];
                obj.IsFolder = (obj.IsFolder === true || folderTypes.includes(obj.Type));
            }
        }

        if (Array.isArray(obj.MediaSources)) {
            obj.MediaSources.forEach(ms => {
                if (ms) {
                    ms.Id = toUUID(ms.Id || currentId);
                    ms.ServerId = PROXY_SERVER_ID;
                    ms.IgnoreDts = ms.IgnoreDts || false;
                    ms.IgnoreIndex = ms.IgnoreIndex || false;
                    ms.GenPtsInput = ms.GenPtsInput || false;
                    ms.TranscodingSubProtocol = ms.TranscodingSubProtocol || "hls";
                    ms.HasSegments = ms.HasSegments || false;
                    ms.IsInfiniteStream = ms.IsInfiniteStream || false;
                    ms.RequiresOpening = ms.RequiresOpening || false;
                    ms.RequiresClosing = ms.RequiresClosing || false;
                    ms.RequiresLooping = ms.RequiresLooping || false;
                    ms.SupportsProbing = ms.SupportsProbing || false;
                    ms.SupportsDirectPlay = ms.SupportsDirectPlay !== undefined ? ms.SupportsDirectPlay : true;
                }
            });
        }

        if (Array.isArray(obj.Chapters)) {
            obj.Chapters.forEach(ch => {
                if (ch) ch.ImageDateModified = ch.ImageDateModified || "0001-01-01T00:00:00.0000000Z";
            });
        }

        const embySpecificKeys = [
            'LockedFields', 'ThemeSongIds', 'ThemeVideoIds', 
            'Trickplay', 'LocalTrailerCount', 'AnimeSeriesIndex', 'PresentationUniqueKey',
            'SeriesPresentationUniqueKey', 'ExternalEtag', 'SyncPercent', 
            'PrimaryVersionId', 'TagItems', 'AudioAnnotations',
            'VideoAnnotations', 'CriticRatingSummary', 'CriticRating', 'LockData',
            'MarkerType', 'ChapterIndex'
        ];

        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            const val = obj[key];
            if (val === null) { delete obj[key]; continue; }
            if (embySpecificKeys.includes(key)) { delete obj[key]; continue; }
            if (val === undefined) continue;

            let needsUUID = false;
            if (key === 'Id' || key === 'ItemId' || key === 'UserId' || key === 'ParentId') {
                needsUUID = true;
            } else if (key.endsWith('Ids') && key !== 'ProviderIds') {
                needsUUID = true;
            } else if (key.endsWith('Id') && !['ServerId', 'ClientId', 'DeviceId', 'AuthenticationProviderId', 'PasswordResetProviderId'].includes(key)) {
                needsUUID = true;
            }

            if (needsUUID) {
                if (typeof val === 'string' || typeof val === 'number') {
                    obj[key] = toUUID(val);
                } else if (Array.isArray(val)) {
                    obj[key] = val.filter(v => v !== null).map(v => {
                        if (typeof v === 'string' || typeof v === 'number') return toUUID(v);
                        if (typeof v === 'object' && v !== null) deepPatch(v, currentId);
                        return v;
                    });
                } else if (typeof val === 'object') {
                    deepPatch(val, currentId);
                }
            } else if (typeof val === 'object') {
                deepPatch(val, currentId);
            }
        }

        const fixUserData = (u, fallbackId) => {
            if (u && typeof u === 'object') {
                u.PlayCount = u.PlayCount || 0;
                u.PlaybackPositionTicks = u.PlaybackPositionTicks || 0;
                u.Key = u.Key || fallbackId;
                u.ItemId = toUUID(u.ItemId || fallbackId);
                if (u.Played === undefined) u.Played = (u.PlayCount > 0);
            }
        };
        if (obj.UserData) fixUserData(obj.UserData, currentId);
    }
};

// Hardcoded mocks
app.get('/LiveTv/Recordings/Folders', (req, res) => res.json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
app.get('/LiveTv/Info', (req, res) => res.json({ IsEnabled: false, EnabledUsers: [] }));
app.get('/DisplayPreferences/default', (req, res) => res.json({ Id: "default", Client: req.query.client || "Wholphin", CustomPrefs: {} }));
app.post(['/Sessions/Capabilities', '/emby/Sessions/Capabilities'], (req, res) => res.status(204).send());
app.get('/socket', (req, res) => res.status(200).send(""));
app.post('/ClientLog/Document', (req, res) => res.status(200).send("Log ignored"));
app.get('/QuickConnect/Enabled', (req, res) => res.send("false")); 
app.get('/Branding/Configuration', (req, res) => res.json({ LoginDisclaimer: "", CustomHtml: "" }));

// --- 4. Passive State Recovery Sniffer ---
app.use((req, res, next) => {
    try {
        const urlObj = new URL(req.url, 'http://localhost');
        const uid = urlObj.searchParams.get('userId') || urlObj.searchParams.get('UserId');
        let token = "";
        const authHeader = req.headers['x-emby-authorization'] || req.headers['authorization'] || "";
        const tokenMatch = authHeader.match(/Token="([^"]+)"/i);
        if (tokenMatch) token = tokenMatch[1];
        else token = urlObj.searchParams.get('api_key') || urlObj.searchParams.get('Token');

        if (uid && token) {
            let cleanUid = uid.replace(/-/g, '').toLowerCase();
            if (cleanUid.startsWith('ffffffff')) cleanUid = cleanUid.replace(/^f+/i, '').replace(/^0+/, '');
            if (cleanUid === "") cleanUid = "0";
            tokenToUserId[token] = cleanUid;
        }
    } catch(e) {}
    next();
});

app.get('/Videos/:itemId/stream*', (req, res) => {
    const itemId = req.params.itemId.replace(/-/g, '').replace(/^f+/i, '').replace(/^0+/, '');
    const newUrl = req.originalUrl.replace(req.params.itemId, itemId);
    res.redirect(302, `${EMBY_URL}${newUrl}`);
});

// --- 5. The Global Intercepting Proxy ---
const getUserIdFromReq = (url, req) => {
    try {
        const urlObj = new URL(url, 'http://localhost');
        let uid = urlObj.searchParams.get('userId') || urlObj.searchParams.get('UserId');
        if (uid) {
            let cleanUid = uid.replace(/-/g, '').toLowerCase();
            if (cleanUid.startsWith('ffffffff')) cleanUid = cleanUid.replace(/^f+/i, '').replace(/^0+/, '');
            if (cleanUid === "") cleanUid = "0";
            return cleanUid;
        }
        let token = "";
        const authHeader = req.headers['x-emby-authorization'] || req.headers['authorization'] || "";
        const tokenMatch = authHeader.match(/Token="([^"]+)"/i);
        if (tokenMatch) token = tokenMatch[1];
        else token = urlObj.searchParams.get('api_key') || urlObj.searchParams.get('Token');
        return tokenToUserId[token];
    } catch (e) { return null; }
};

const translateHeaders = (proxyReq, req) => {
    const cleanHeader = (header) => {
        if (!header) return header;
        return header.replace(/Client="[^"]+"/gi, 'Client="Emby"')
                     .replace(/Device="([^"]+)"/gi, (m, deviceName) => `Device="${deviceName.replace(/\+/g, ' ')}"`);
    };
    const jellyAuth = req.headers['x-emby-authorization'];
    if (jellyAuth) proxyReq.setHeader('X-Emby-Authorization', cleanHeader(jellyAuth));
    const stdAuth = req.headers['authorization'];
    if (stdAuth) proxyReq.setHeader('Authorization', cleanHeader(stdAuth));
    const token = req.headers['x-emby-token'] || req.headers['x-mediabrowser-token'];
    if (token) proxyReq.setHeader('X-Emby-Token', token);
};

app.use('/', createProxyMiddleware({ 
    target: EMBY_URL, 
    changeOrigin: true, 
    selfHandleResponse: true,
    onError: (err, req, res) => {
        console.error('[Proxy Error]', err);
        res.status(500).send('Proxy upstream error');
    },
    onProxyReq: (proxyReq, req, res) => {
        let newPath = req.url;

        // Catch legacy UserImage requests seen in logs
        if (newPath.includes('/UserImage?')) {
            const urlObj = new URL(newPath, 'http://localhost');
            let uid = urlObj.searchParams.get('userId');
            if (uid) {
                uid = uid.replace(/-/g, '').toLowerCase();
                if (uid.startsWith('ffffffff')) uid = uid.replace(/^f+/i, '').replace(/^0+/, '');
                if (uid === "") uid = "0";
                // Redirect to the proper Emby image path
                newPath = `/emby/Users/${uid}/Images/Primary?` + urlObj.searchParams.toString().replace(/userId=[^&]+/, '');
            }
        }

        const userId = getUserIdFromReq(newPath, req);
        if (userId) {
            if (newPath.match(/^\/Users\/Me(\?|\/|$)/i)) {
                newPath = newPath.replace(/^\/Users\/Me/i, `/Users/${userId}`);
            } else if (newPath.match(/^\/UserViews/i)) {
                newPath = newPath.replace(/^\/UserViews/i, `/Users/${userId}/Views`);
            } else if (newPath.match(/^\/UserItems\/Resume/i)) {
                newPath = newPath.replace(/^\/UserItems\/Resume/i, `/Users/${userId}/Items/Resume`);
            } else if (newPath.match(/^\/Items\/Latest/i)) {
                newPath = newPath.replace(/^\/Items\/Latest/i, `/Users/${userId}/Items/Latest`);
            } else if (newPath.match(/^\/Shows\/NextUp/i)) {
                if (!newPath.toLowerCase().includes('userid=')) {
                    newPath += (newPath.includes('?') ? '&' : '?') + `UserId=${userId}`;
                }
            } else if (newPath.match(/^\/Collections\/([0-9a-fA-F-]+)\/Items/i)) {
                const match = newPath.match(/^\/Collections\/([0-9a-fA-F-]+)\/Items/i);
                const colId = match[1];
                const parts = newPath.split('?');
                let query = parts.length > 1 ? parts[1] : '';
                newPath = `/Users/${userId}/Items?ParentId=${colId}&Recursive=true&Fields=BasicSyncInfo,CanDelete${query ? '&' + query : ''}`;
            } else if (newPath.match(/^\/Items\/([0-9a-fA-F-]{32,36})\/PlaybackInfo/i)) {
                const parts = newPath.split('?');
                let base = parts[0];
                let query = parts[1] || "";
                if (!query.toLowerCase().includes('userid=')) {
                    query = (query ? query + '&' : '') + `UserId=${userId}`;
                }
                newPath = base + '?' + query;
            } else if (newPath.match(/^\/Items\/[0-9a-fA-F-]{32,36}/i) && !newPath.match(/\/(Images|ThemeMedia)\//i)) {
                newPath = newPath.replace(/^\/Items\/([0-9a-fA-F-]+)/i, (m, id) => `/Users/${userId}/Items/${id}`);
            } else if (newPath.match(/^\/Items(\?|$)/i) && !newPath.includes('/Items/RemoteSearch')) {
                newPath = newPath.replace(/^\/Items/i, `/Users/${userId}/Items`);
            }
        }

        // --- Clean up Emby-incompatible query fields and fix array formats ---
        if (newPath.includes('?')) {
            const parts = newPath.split('?');
            let queryParams = new URLSearchParams(parts[1]);
            let modified = false;
            
            // 1. Prevent ServiceStack 500 error by removing duplicate userId from query
            if (parts[0].match(/\/Users\//i)) { 
                if (queryParams.has('userId')) { queryParams.delete('userId'); modified = true; }
                if (queryParams.has('UserId')) { queryParams.delete('UserId'); modified = true; }
            }

            // 2. Consolidate array params (Emby needs comma-separated strings; Jellyfin sends repeating keys)
            const arrayParams = ['fields', 'Fields', 'includeItemTypes', 'IncludeItemTypes', 'excludeItemTypes', 'ExcludeItemTypes', 'Filters', 'filters', 'sortBy', 'SortBy'];
            arrayParams.forEach(param => {
                if (queryParams.has(param)) {
                    const values = queryParams.getAll(param);
                    if (values.length > 1) {
                        queryParams.delete(param);
                        queryParams.set(param, values.join(','));
                        modified = true;
                    }
                }
            });

            // 3. Remove Jellyfin-exclusive Enums that crash Emby's ServiceStack model binder
            // Fields:
            ['fields', 'Fields'].forEach(param => {
                if (queryParams.has(param)) {
                    let val = queryParams.get(param);
                    if (val.match(/BasicSyncInfo|SeasonUserData/i)) {
                        val = val.replace(/BasicSyncInfo/gi, '')
                                 .replace(/SeasonUserData/gi, '')
                                 .replace(/,+$/, '')
                                 .replace(/^,+/, '')
                                 .replace(/,+/g, ',');
                        if (val) {
                            queryParams.set(param, val);
                        } else {
                            queryParams.delete(param);
                        }
                        modified = true;
                    }
                }
            });

            // SortBy: Emby does not support "Default" as an enum value. It triggers a 500.
            ['sortBy', 'SortBy'].forEach(param => {
                if (queryParams.has(param)) {
                    let val = queryParams.get(param);
                    let filtered = val.split(',').filter(v => v.toLowerCase() !== 'default');
                    if (filtered.length !== val.split(',').length) {
                        if (filtered.length > 0) {
                            queryParams.set(param, filtered.join(','));
                        } else {
                            queryParams.delete(param);
                        }
                        modified = true;
                    }
                }
            });

            // ItemTypes: Jellyfin added several BaseItemKinds that Emby doesn't recognize.
            ['includeItemTypes', 'IncludeItemTypes', 'excludeItemTypes', 'ExcludeItemTypes'].forEach(param => {
                if (queryParams.has(param)) {
                    let val = queryParams.get(param);
                    const jellyExclusives = ['basepluginfolder', 'manualplaylistsfolder', 'playlistsfolder', 'livetvchannel', 'livetvprogram'];
                    let filtered = val.split(',').filter(v => !jellyExclusives.includes(v.toLowerCase()));
                    if (filtered.length !== val.split(',').length) {
                        if (filtered.length > 0) {
                            queryParams.set(param, filtered.join(','));
                        } else {
                            queryParams.delete(param);
                        }
                        modified = true;
                    }
                }
            });

            if (modified) {
                // Reconstruct the URL and ensure commas stay native instead of URL-encoded `%2C`
                let newQuery = queryParams.toString().replace(/%2C/gi, ',');
                newPath = parts[0] + (newQuery ? '?' + newQuery : '');
            }
        }

        // Global UUID Deflator (with leading zero fix for IDs like "1")
        newPath = newPath.replace(/([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})/ig, (match) => {
            let deflated = match.replace(/-/g, '').toLowerCase();
            if (deflated.startsWith('ffffffff')) {
                let stripped = deflated.replace(/^f+/i, '').replace(/^0+/, '');
                return stripped === "" ? "0" : stripped;
            }
            return deflated;
        });

        // Ensure Emby gets the /emby/ prefix for image/user requests and correct query key
        if (newPath.match(/^\/(Users|Items)\//i) && !newPath.startsWith('/emby/')) {
            newPath = '/emby' + newPath;
        }
        
        // FIXED REGEX: Case-insensitivity check to ensure token passes auth correctly on image tags
        if (newPath.match(/\/Images\//i) && newPath.match(/([?&])token=/i)) {
            newPath = newPath.replace(/([?&])token=/ig, '$1api_key=');
        }

        console.log(`[Emby Bound]     -> ${req.method} ${newPath}`);
        proxyReq.path = newPath;
        translateHeaders(proxyReq, req);

        if (req.body && Object.keys(req.body).length > 0 && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
            const deflateBodyUUIDs = (obj) => {
                for (const key in obj) {
                    if (typeof obj[key] === 'string') {
                        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(obj[key])) {
                            let deflated = obj[key].replace(/-/g, '').toLowerCase();
                            if (deflated.startsWith('ffffffff')) {
                                let stripped = deflated.replace(/^f+/i, '').replace(/^0+/, '');
                                obj[key] = stripped === "" ? "0" : stripped;
                            } else {
                                obj[key] = deflated;
                            }
                        }
                    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                        deflateBodyUUIDs(obj[key]);
                    }
                }
            };
            deflateBodyUUIDs(req.body);
            fixRequestBody(proxyReq, req);
        }
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        if (proxyRes.statusCode >= 400) {
            if (proxyRes.headers['content-type']?.includes('application/json')) {
                res.statusCode = 200; 
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return Buffer.from(JSON.stringify({ Items: [], TotalRecordCount: 0, StartIndex: 0 }));
            }
            return responseBuffer;
        }

        if (proxyRes.headers['content-type']?.includes('application/json')) {
            try {
                let data = JSON.parse(responseBuffer.toString('utf8'));

                if (req.url.match(/\/System\/Info\/Public/i)) {
                    data.Id = PROXY_SERVER_ID;
                    data.Version = "10.8.10";
                    data.ProductName = "Jellyfin Server";
                    data.StartupWizardCompleted = true;
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (req.url.match(/\/System\/Info/i)) {
                    data.Id = PROXY_SERVER_ID;
                    data.ServerName = "Wholby Proxy";
                    data.Version = "10.8.10";
                    return Buffer.from(JSON.stringify(data));
                }

                if (req.url.match(/\/Users\/AuthenticateByName/i)) {
                    if (data.AccessToken && data.User) {
                        let uidStr = String(data.User.Id).replace(/-/g, '').toLowerCase();
                        tokenToUserId[data.AccessToken] = uidStr;
                    }
                    if (data.User) data.User = patchUser(data.User);
                    if (data.SessionInfo) data.SessionInfo = patchSessionInfo(data.SessionInfo);
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (req.url.match(/\/Shows\/NextUp/i) && Array.isArray(data)) {
                    data = { Items: data, TotalRecordCount: data.length, StartIndex: 0 };
                }

                if (req.url.match(/^\/?(emby\/)?Users(\/Public|\?|$)/i) && Array.isArray(data)) {
                    data = data.map(u => patchUser(u));
                    return Buffer.from(JSON.stringify(data)); 
                }

                if (req.url.match(/^\/?(emby\/)?Users\/(Me|[a-z0-9\-]+)(\?|$)/i) && data.Id) {
                    data = patchUser(data);
                    return Buffer.from(JSON.stringify(data)); 
                }

                deepPatch(data); 
                return Buffer.from(JSON.stringify(data));
            } catch (e) {
                console.error("[Proxy Intercept Error]", e);
                return responseBuffer; 
            }
        }
        return responseBuffer;
    })
}));

app.listen(8096, '0.0.0.0', () => console.log(`Wholby Proxy deployed on port 8096`));
