# app/routes/elog.py
"""
REST endpoints for the PSI ELOG logbook.

Reading, searching and posting go through ElogClient, which holds the shared
service account. Entries are attributed to the WebDAQ user who posts them via
the ``Author`` attribute, unless the composer overrides it.
"""

import json
import mimetypes
import os

from flask import Blueprint, request, jsonify, Response

from app.models.user import User
from ..utils.jwt_utils import jwt_required_custom, get_current_user
from ..services.elog_client import get_elog_client, ElogError

bp = Blueprint('elog', __name__)

elog_client = get_elog_client()


def current_username() -> str:
    """The WebDAQ user making the request, used as the default ELOG author."""
    try:
        user = User.query.get(get_current_user())
        return user.username if user else ''
    except Exception:
        return ''


@bp.route('/elog/settings', methods=['GET'])
@jwt_required_custom
def get_settings():
    """ELOG connection settings; the password is returned masked."""
    settings = elog_client.get_settings()
    settings['default_author'] = current_username()
    return jsonify(settings)


@bp.route('/elog/settings', methods=['POST'])
@jwt_required_custom
def set_settings():
    """Update the connection settings. An empty password keeps the stored one."""
    data = request.get_json() or {}
    elog_client.set_settings(
        enabled=data.get('enabled'),
        url=data.get('url'),
        user=data.get('user'),
        password=data.get('password'),
        default_attributes=data.get('default_attributes'),
    )
    return jsonify({'message': 'ELOG settings updated', 'settings': elog_client.get_settings()})


@bp.route('/elog/test', methods=['POST'])
@jwt_required_custom
def test_connection():
    """Check the server answers with the configured account."""
    return jsonify(elog_client.test_connection())


@bp.route('/elog/entries', methods=['GET'])
@jwt_required_custom
def list_entries():
    """Recent entries, newest first, or the results of a text search."""
    try:
        limit = max(1, min(int(request.args.get('limit', 20)), 100))
        offset = max(0, int(request.args.get('offset', 0)))
    except ValueError:
        return jsonify({'message': 'limit and offset must be numbers'}), 400

    search = (request.args.get('search') or '').strip()
    try:
        if search:
            return jsonify(elog_client.search_entries(search, limit=limit))
        return jsonify(elog_client.list_entries(limit=limit, offset=offset))
    except ElogError as e:
        return jsonify({'message': str(e)}), 502


@bp.route('/elog/entries/<int:msg_id>', methods=['GET'])
@jwt_required_custom
def read_entry(msg_id):
    """A single entry, with its full text and attachment URLs."""
    try:
        return jsonify(elog_client.read_entry(msg_id))
    except ElogError as e:
        return jsonify({'message': str(e)}), 502


@bp.route('/elog/entries', methods=['POST'])
@jwt_required_custom
def post_entry():
    """
    Submit a new entry, or a reply to an existing one.

    Accepts JSON, or multipart/form-data when there are attachments (attributes
    then arrive as an 'attributes' JSON string alongside the files).
    """
    attachments = []
    if request.files:
        data = request.form.to_dict()
        try:
            data['attributes'] = json.loads(data.get('attributes') or '{}')
        except ValueError:
            return jsonify({'message': 'attributes must be a JSON object'}), 400
        attachments = request.files.getlist('attachments')
    else:
        data = request.get_json() or {}

    text = data.get('text', '')
    attributes = dict(data.get('attributes') or {})
    reply_to = data.get('reply_to') or None

    if not text.strip() and not attachments:
        return jsonify({'message': 'The entry is empty.'}), 400

    # Attribution: the shared account authenticates, the WebDAQ user signs.
    if not attributes.get('Author'):
        attributes['Author'] = current_username() or 'WebDAQ'

    try:
        msg_id = elog_client.post_entry(
            text=text,
            attributes=attributes,
            reply_to=int(reply_to) if reply_to else None,
            attachments=attachments,
            encoding=data.get('encoding', 'plain'),
        )
    except ElogError as e:
        return jsonify({'message': str(e)}), 502
    except (TypeError, ValueError) as e:
        return jsonify({'message': f'Invalid entry: {e}'}), 400

    return jsonify({'id': msg_id, 'message': f'Posted entry #{msg_id}'}), 201


@bp.route('/elog/attributes', methods=['GET'])
@jwt_required_custom
def get_attributes():
    """
    The attribute fields this logbook uses, learned from recent entries, plus
    the defaults from settings and the author to pre-fill.
    """
    settings = elog_client.get_settings()
    try:
        names = elog_client.attribute_names()
    except ElogError as e:
        return jsonify({'message': str(e)}), 502
    return jsonify({
        'names': names,
        'defaults': settings.get('default_attributes', {}),
        'author': current_username(),
    })


@bp.route('/elog/attachment', methods=['GET'])
@jwt_required_custom
def download_attachment():
    """Proxy an attachment: the browser has no session on the ELOG server."""
    url = request.args.get('url', '')
    try:
        content = elog_client.download_attachment(url)
    except ElogError as e:
        return jsonify({'message': str(e)}), 502

    name = os.path.basename(url.split('?')[0]) or 'attachment'
    content_type = mimetypes.guess_type(name)[0] or 'application/octet-stream'
    # Only pictures and PDFs are shown in place. Anything else is downloaded
    # rather than rendered, so an HTML or SVG attachment cannot run as a page
    # served by this server.
    inline = ((content_type.startswith('image/') and content_type != 'image/svg+xml')
              or content_type == 'application/pdf')
    disposition = 'inline' if inline else 'attachment'
    return Response(content, mimetype=content_type,
                    headers={'Content-Disposition': f'{disposition}; filename="{name}"',
                             'X-Content-Type-Options': 'nosniff'})
