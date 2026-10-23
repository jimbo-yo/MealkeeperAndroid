package com.example.mealkeeper

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Hands meal files written by MainActivity.shareMeal to the app the user shares them with.
 * A minimal, read-only stand-in for androidx FileProvider: it only serves files in cache/shared/, and other apps
 * can only reach them through the temporary permission granted with each share (the provider isn't exported).
 */
class SharedMealProvider : ContentProvider() {
    override fun onCreate() = true

    private fun fileFor(uri: Uri): File? {
        val dir = sharedDir(context ?: return null)
        val file = File(dir, uri.lastPathSegment ?: return null)
        return file.takeIf { it.parentFile?.canonicalPath == dir.canonicalPath && it.isFile }
    }

    override fun getType(uri: Uri) = "application/json"

    // Receiving apps ask for the display name and size (e.g. to show "Sunday supper.prompttopan.json").
    override fun query(
        uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?
    ): Cursor? {
        val file = fileFor(uri) ?: return null
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        return MatrixCursor(columns).apply {
            addRow(columns.map {
                when (it) {
                    OpenableColumns.DISPLAY_NAME -> file.name
                    OpenableColumns.SIZE -> file.length()
                    else -> null
                }
            })
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("Shared meal files are read-only")
        val file = fileFor(uri) ?: throw FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        throw UnsupportedOperationException()

    companion object {
        fun sharedDir(context: Context) = File(context.cacheDir, "shared").apply { mkdirs() }

        fun uriFor(context: Context, file: File): Uri =
            Uri.Builder().scheme("content").authority("${context.packageName}.shared").appendPath(file.name).build()
    }
}
